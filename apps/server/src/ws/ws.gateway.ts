import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../core/auth/services/token.service';
import { JwtPayload, JwtType } from '../core/auth/dto/jwt-payload';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { WsService } from './ws.service';
import { getSpaceRoomName, getUserRoomName } from './ws.utils';
import {
  readClientBuildVersion,
  resolveClientDistPath,
} from '../common/helpers/client-version';
import * as cookie from 'cookie';

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket'],
})
export class WsGateway
  implements
    OnGatewayConnection,
    OnGatewayInit,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WsGateway.name);

  // The build version of the client bundle shipped in this image, read once at
  // startup from client/dist/version.json (single source of truth, same value
  // baked into the client's APP_VERSION). Empty string => version.json missing
  // or empty => the proactive version-coherence reload feature stays inert.
  private appVersion = '';

  constructor(
    private tokenService: TokenService,
    private spaceMemberRepo: SpaceMemberRepo,
    private wsService: WsService,
  ) {}

  onModuleInit(): void {
    this.appVersion = readClientBuildVersion(resolveClientDistPath());
    if (this.appVersion) {
      this.logger.log(`app-version reload: ACTIVE (v=${this.appVersion})`);
    } else {
      this.logger.log(
        'app-version reload: DISABLED (version.json missing/empty)',
      );
    }
  }

  afterInit(server: Server): void {
    this.wsService.setServer(server);
  }

  async handleConnection(client: Socket, ...args: any[]): Promise<void> {
    try {
      const cookies = cookie.parse(client.handshake.headers.cookie);
      const token: JwtPayload = await this.tokenService.verifyJwt(
        cookies['authToken'],
        JwtType.ACCESS,
      );

      const userId = token.sub;
      const workspaceId = token.workspaceId;

      client.data.userId = userId;

      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      const userRoom = getUserRoomName(userId);
      const workspaceRoom = `workspace-${workspaceId}`;
      const spaceRooms = userSpaceIds.map((id) => getSpaceRoomName(id));

      client.join([userRoom, workspaceRoom, ...spaceRooms]);

      // Announce this container's client build version to the freshly
      // authenticated socket. On a redeploy the client reconnects to the new
      // container and receives the new version here, letting it guard-reload
      // before it hits a stale lazy chunk. Per-connect only (no broadcast):
      // natural reconnect covers both single-container and cluster without a
      // thundering-herd fleet reload.
      client.emit('app-version', { version: this.appVersion });
    } catch (err) {
      client.emit('Unauthorized');
      client.disconnect();
    }
  }

  @SubscribeMessage('message')
  handleMessage(_client: Socket, _data: any): void {
    // Inbound tree events from clients are no longer accepted: tree updates are
    // now server-authoritative (broadcast by PageWsListener from domain events).
    // The old client-relay path was removed to close that attack surface.
  }

  /*
  @SubscribeMessage('join-room')
  handleJoinRoom(client: Socket, @MessageBody() roomName: string): void {
    // if room is a space, check if user has permissions
    //client.join(roomName);
  }

  @SubscribeMessage('leave-room')
  handleLeaveRoom(client: Socket, @MessageBody() roomName: string): void {
    client.leave(roomName);
  }
 */

  onModuleDestroy() {
    if (this.server) {
      this.server.close();
    }
  }
}
