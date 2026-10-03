export type LinkEditorPanelProps = {
  initialUrl?: string;
  onSetLink: (url: string, internal?: boolean) => void;
  onUnsetLink?: () => void;
  // Overrides the route param for callers mounted outside <Routes> (the
  // app-wide link popover), where useParams() is empty.
  spaceSlug?: string;
};
