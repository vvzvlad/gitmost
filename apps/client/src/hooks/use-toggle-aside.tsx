import {
  asideStateAtom,
  type AsideTab,
} from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import { useAtom } from "jotai";
import { markOperationStart } from "@/lib/telemetry/vitals";

export const ASIDE_PANEL_ID = "aside-panel";

// #683 `comments_open` — mark the start of a comments-panel open at the user's
// toggle. The panel opens when switching to a different tab, or when re-toggling
// the same tab while it is currently closed. The matching measure fires at the
// comment list's first render (comment-list-with-tabs.tsx). Marking on a CLOSE is
// harmless (measureOperation only consumes a mark at an open render), but we gate
// on the opening transition anyway so a repeated close/open doesn't overwrite a
// live mark mid-measure.
function markCommentsOpenStart(
  tab: AsideTab,
  currentTab: AsideTab,
  currentlyOpen: boolean,
): void {
  if (tab !== "comments") return;
  const willOpen = tab === currentTab ? !currentlyOpen : true;
  if (willOpen) markOperationStart("comments_open");
}

const useToggleAside = () => {
  const [asideState, setAsideState] = useAtom(asideStateAtom);

  const toggleAside = (tab: AsideTab) => {
    markCommentsOpenStart(tab, asideState.tab, asideState.isAsideOpen);
    if (asideState.tab === tab) {
      setAsideState({ tab, isAsideOpen: !asideState.isAsideOpen });
    } else {
      setAsideState({ tab, isAsideOpen: true });
    }
  };

  return toggleAside;
};

export const useAsideTriggerProps = (tab: AsideTab) => {
  const [asideState, setAsideState] = useAtom(asideStateAtom);

  return {
    onClick: () => {
      markCommentsOpenStart(tab, asideState.tab, asideState.isAsideOpen);
      if (asideState.tab === tab) {
        setAsideState({ tab, isAsideOpen: !asideState.isAsideOpen });
      } else {
        setAsideState({ tab, isAsideOpen: true });
      }
    },
    "aria-expanded": asideState.isAsideOpen && asideState.tab === tab,
    "aria-controls": ASIDE_PANEL_ID,
  } as const;
};

export default useToggleAside;
