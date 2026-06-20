import { BadRequestException, Injectable } from '@nestjs/common';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { AiAgentRole } from '@docmost/db/types/entity.types';
import { CreateAgentRoleDto, UpdateAgentRoleDto } from './dto/agent-role.dto';
import { RoleModelConfig } from './role-model-config';

/**
 * Public view of an agent role. There are no secret columns on this table (the
 * model creds live in ai_provider_credentials, keyed by driver), so the whole
 * row is safe to return to admins. The list endpoint is also reachable by any
 * member for the chat picker — the same shape is fine (instructions are
 * admin-authored, workspace-scoped, non-sensitive trusted content).
 */
export interface AgentRoleView {
  id: string;
  name: string;
  emoji: string | null;
  description: string | null;
  instructions: string;
  modelConfig: RoleModelConfig | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Admin business logic for agent roles: workspace-scoped CRUD with validation.
 * A role only shapes the system-prompt persona + an optional model override; it
 * never changes the toolset or the CASL boundary.
 */
@Injectable()
export class AiAgentRolesService {
  constructor(private readonly repo: AiAgentRoleRepo) {}

  async list(workspaceId: string): Promise<AgentRoleView[]> {
    const rows = await this.repo.listByWorkspace(workspaceId);
    return rows.map((r) => this.toView(r));
  }

  async create(
    workspaceId: string,
    creatorId: string,
    dto: CreateAgentRoleDto,
  ): Promise<AgentRoleView> {
    const name = (dto.name ?? '').trim();
    const instructions = (dto.instructions ?? '').trim();
    if (!name) throw new BadRequestException('Role name is required');
    if (!instructions) {
      throw new BadRequestException('Role instructions are required');
    }
    const modelConfig = normalizeModelConfig(dto.modelConfig);

    const row = await this.repo.insert({
      workspaceId,
      creatorId,
      name,
      emoji: emptyToNull(dto.emoji),
      description: emptyToNull(dto.description),
      instructions,
      modelConfig: modelConfig as Record<string, unknown> | null,
      enabled: dto.enabled ?? true,
    });
    return this.toView(row);
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateAgentRoleDto,
  ): Promise<AgentRoleView> {
    const existing = await this.repo.findById(id, workspaceId);
    if (!existing) throw new BadRequestException('Role not found');

    // Validate non-empty only when the field is actually being changed.
    if (dto.name !== undefined && dto.name.trim().length === 0) {
      throw new BadRequestException('Role name cannot be empty');
    }
    if (dto.instructions !== undefined && dto.instructions.trim().length === 0) {
      throw new BadRequestException('Role instructions cannot be empty');
    }

    await this.repo.update(id, workspaceId, {
      name: dto.name?.trim(),
      // undefined => unchanged; '' => clear to null.
      emoji: dto.emoji === undefined ? undefined : emptyToNull(dto.emoji),
      description:
        dto.description === undefined ? undefined : emptyToNull(dto.description),
      instructions: dto.instructions?.trim(),
      // undefined => unchanged; null => clear; object => normalize + set.
      modelConfig:
        dto.modelConfig === undefined
          ? undefined
          : (normalizeModelConfig(dto.modelConfig) as
              | Record<string, unknown>
              | null),
      enabled: dto.enabled,
    });

    const updated = await this.repo.findById(id, workspaceId);
    return this.toView(updated as AiAgentRole);
  }

  async remove(workspaceId: string, id: string): Promise<{ success: true }> {
    const existing = await this.repo.findById(id, workspaceId);
    if (!existing) throw new BadRequestException('Role not found');
    await this.repo.softDelete(id, workspaceId);
    return { success: true };
  }

  private toView(row: AiAgentRole): AgentRoleView {
    return {
      id: row.id,
      name: row.name,
      emoji: row.emoji ?? null,
      description: row.description ?? null,
      instructions: row.instructions,
      modelConfig: (row.modelConfig ?? null) as RoleModelConfig | null,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** '' / whitespace-only / undefined => null; otherwise the trimmed value. */
function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize an incoming modelConfig DTO to the persisted shape, or null when
 * there is no usable override (no driver and no chatModel). The DTO's @IsIn
 * already restricts `driver` to a supported value.
 */
function normalizeModelConfig(
  cfg: { driver?: string; chatModel?: string } | null | undefined,
): RoleModelConfig | null {
  if (!cfg) return null;
  const driver = cfg.driver;
  const chatModel =
    typeof cfg.chatModel === 'string' && cfg.chatModel.trim().length > 0
      ? cfg.chatModel.trim()
      : undefined;
  if (!driver && !chatModel) return null;
  const out: RoleModelConfig = {};
  if (driver) out.driver = driver as RoleModelConfig['driver'];
  if (chatModel) out.chatModel = chatModel;
  return out;
}
