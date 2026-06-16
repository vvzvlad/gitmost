import { Injectable, Logger } from '@nestjs/common';
import { pathToFileURL } from 'node:url';
import { FastifyReply, FastifyRequest } from 'fastify';
import { EnvironmentService } from '../environment/environment.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';

// Minimal shape of the embedded MCP HTTP handler exported by @docmost/mcp/http.
interface McpHttpHandler {
  handleRequest(
    req: unknown,
    res: unknown,
    parsedBody?: unknown,
  ): Promise<void>;
}

interface McpHttpModule {
  createMcpHttpHandler(config: {
    apiUrl: string;
    email: string;
    password: string;
  }): McpHttpHandler;
}

// TS with module:commonjs downlevels a literal import() to require(), which
// cannot load the ESM-only @docmost/mcp package. Indirect through Function so
// the real dynamic import() survives compilation and can load ESM from
// CommonJS at runtime.
const esmImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private handler: McpHttpHandler | null = null;
  private handlerPromise: Promise<McpHttpHandler> | null = null;
  private warnedMissingCreds = false;

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  // Service account the embedded MCP uses to talk back to this Docmost
  // instance over loopback REST + the collaboration WebSocket.
  private getEmail(): string | undefined {
    return process.env.MCP_DOCMOST_EMAIL;
  }

  private getPassword(): string | undefined {
    return process.env.MCP_DOCMOST_PASSWORD;
  }

  private getApiUrl(): string {
    return (
      process.env.MCP_DOCMOST_API_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}/api`
    );
  }

  private credsConfigured(): boolean {
    return Boolean(this.getEmail() && this.getPassword());
  }

  // MCP is a community feature gated by the workspace `ai.mcp` setting (the
  // same toggle the settings UI writes). Docmost self-host is single-workspace,
  // so we read the first/default workspace and treat settings.ai.mcp === true
  // as enabled.
  private async isEnabled(): Promise<boolean> {
    try {
      const workspace = await this.workspaceRepo.findFirst();
      const settings = (workspace?.settings ?? {}) as {
        ai?: { mcp?: boolean };
      };
      return settings?.ai?.mcp === true;
    } catch (err) {
      this.logger.error('Failed to read workspace MCP setting', err as Error);
      return false;
    }
  }

  // Lazily create the HTTP handler exactly once. The import is indirected so
  // the ESM-only @docmost/mcp package can be loaded from this CommonJS module.
  private async getHandler(): Promise<McpHttpHandler> {
    if (this.handler) {
      return this.handler;
    }
    if (!this.handlerPromise) {
      this.handlerPromise = (async () => {
        // Resolve the package's HTTP entry to an absolute path, then import it as a
        // file:// URL. require.resolve honours the package "exports" map without
        // executing the module, avoiding bare-specifier resolution-base fragility.
        const httpEntry = require.resolve('@docmost/mcp/http');
        const mod = (await esmImport(
          pathToFileURL(httpEntry).href,
        )) as McpHttpModule;
        const handler = mod.createMcpHttpHandler({
          apiUrl: this.getApiUrl(),
          email: this.getEmail()!,
          password: this.getPassword()!,
        });
        this.handler = handler;
        return handler;
      })().catch((err) => {
        // Do not cache a rejected import — allow the next request to retry.
        this.handlerPromise = null;
        throw err;
      });
    }
    return this.handlerPromise;
  }

  async handle(req: FastifyRequest, res: FastifyReply): Promise<void> {
    // Optional static bearer-token guard. When MCP_TOKEN is set, the request
    // must carry a matching `Authorization: Bearer <token>` header. When unset,
    // /mcp relies on the workspace toggle and network isolation (no auth).
    const token = process.env.MCP_TOKEN;
    if (token) {
      const authHeader = req.headers['authorization'];
      if (authHeader !== `Bearer ${token}`) {
        res.status(401).send({ error: 'Unauthorized' });
        return;
      }
    }

    if (!(await this.isEnabled())) {
      res.status(403).send({ error: 'MCP is disabled for this workspace' });
      return;
    }

    if (!this.credsConfigured()) {
      if (!this.warnedMissingCreds) {
        this.warnedMissingCreds = true;
        this.logger.warn(
          'MCP is enabled but not configured: set MCP_DOCMOST_EMAIL and MCP_DOCMOST_PASSWORD.',
        );
      }
      res.status(503).send({
        error:
          'MCP is not configured (set MCP_DOCMOST_EMAIL / MCP_DOCMOST_PASSWORD)',
      });
      return;
    }

    // Hand the raw Node req/res to the MCP transport. hijack() tells Fastify
    // to stop managing this response so the transport can write to it directly.
    res.hijack();

    try {
      const handler = await this.getHandler();
      await handler.handleRequest(
        req.raw as unknown,
        res.raw as unknown,
        (req as unknown as { body?: unknown }).body,
      );
    } catch (err) {
      this.logger.error('MCP request handling failed', err as Error);
      if (!res.raw.headersSent) {
        res.raw.statusCode = 500;
        res.raw.setHeader('Content-Type', 'application/json');
        res.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
  }
}
