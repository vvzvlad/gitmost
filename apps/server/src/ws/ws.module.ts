import { Global, Module } from '@nestjs/common';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';
import { WsTreeService } from './ws-tree.service';
import { PageWsListener } from './listeners/page-ws.listener';
import { TokenModule } from '../core/auth/token.module';

@Global()
@Module({
  imports: [TokenModule],
  providers: [WsGateway, WsService, WsTreeService, PageWsListener],
  exports: [WsGateway, WsService, WsTreeService],
})
export class WsModule {}
