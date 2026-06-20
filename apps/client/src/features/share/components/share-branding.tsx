import { Affix, Button } from "@mantine/core";

export default function ShareBranding() {
  return (
    // Pinned to the bottom-RIGHT corner. The AI assistant FAB
    // (share-ai-widget.tsx) is stacked ABOVE this with a higher `bottom`
    // offset, so the two Affix elements never overlap.
    <Affix position={{ bottom: 20, right: 20 }}>
      <Button
        variant="default"
        component="a"
        target="_blank"
        href="https://github.com/vvzvlad/gitmost?ref=public-share"
      >
        Powered by Gitmost
      </Button>
    </Affix>
  );
}
