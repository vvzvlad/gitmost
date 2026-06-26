export type SpaceTreeNode = {
  id: string;
  slugId: string;
  name: string;
  icon?: string;
  position: string;
  spaceId: string;
  parentPageId: string;
  hasChildren: boolean;
  canEdit?: boolean;
  isTemplate?: boolean;
  // Death-timer deadline. null/absent => permanent; ISO string => temporary note.
  temporaryExpiresAt?: string | null;
  children: SpaceTreeNode[];
};
