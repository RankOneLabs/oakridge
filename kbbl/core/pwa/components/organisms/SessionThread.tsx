import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, type DataMessagePartProps } from "@assistant-ui/react";
import { createContext, useContext, useRef, type ReactNode } from "react";
import type { PermissionItem, PlanItem, TurnNoteItem } from "../../../acp/transcript-model";
import type { LoadEarlierResult } from "../../lib/session-transcript-connection";
import { selectTimelineItems } from "../../lib/session-items";
import { useLoadEarlierSentinel } from "../../hooks/useLoadEarlierSentinel";
import { usePrependAnchor } from "../../hooks/usePrependAnchor";
import { useSendInput, type SendInputCallbacks } from "../../hooks/useSendInput";
import { useSessionThreadRuntime } from "../../hooks/useSessionThreadRuntime";
import { AgentMessage } from "../molecules/AgentMessage";
import { PlanCard } from "../molecules/PlanCard";
import { ThoughtBlock } from "../molecules/ThoughtBlock";
import { TurnStateNotice } from "../molecules/TurnStateNotice";
import { UserMessage } from "../molecules/UserMessage";
import { PermissionCard } from "./PermissionCard";
import { ThreadToolCallPart } from "./ThreadToolCallPart";

interface ThreadSession {
  sid: string;
  sessionClosed: boolean;
}

const ThreadSessionContext = createContext<ThreadSession | null>(null);

function ThreadTool({ toolCallId }: { toolCallId: string }) {
  const session = useContext(ThreadSessionContext);
  return session && <ThreadToolCallPart sid={session.sid} toolCallId={toolCallId} />;
}

function ThreadPlan({ data }: DataMessagePartProps<PlanItem>) {
  const [plan] = selectTimelineItems([data]);
  return plan?.kind === "plan" && <PlanCard entries={plan.entries} />;
}

function ThreadPermission({ data }: DataMessagePartProps<PermissionItem>) {
  const session = useContext(ThreadSessionContext);
  const [permission] = selectTimelineItems([data]);
  return session && permission?.kind === "permission" && (
    <PermissionCard sid={session.sid} requestId={permission.requestId} title={permission.title}
      options={permission.options} resolution={permission.resolution} sessionClosed={session.sessionClosed} isAnchor={false} />
  );
}

function ThreadTurnNote({ data }: DataMessagePartProps<TurnNoteItem>) {
  return <TurnStateNotice state={data.state} stopReason={data.stop_reason} detail={data.detail} />;
}

const assistantParts = {
  Text: AgentMessage,
  Reasoning: ThoughtBlock,
  tools: { Fallback: ThreadTool },
  data: { by_name: { plan: ThreadPlan, permission: ThreadPermission, turn_note: ThreadTurnNote } },
};
const userParts = { Text: UserMessage };

function ThreadMessageRow() {
  const id = useAuiState((state) => state.message.id);
  const isUser = useAuiState((state) => state.message.role === "user");
  return (
    <MessagePrimitive.Root data-item-id={id}>
      <MessagePrimitive.Parts components={isUser ? userParts : assistantParts} />
    </MessagePrimitive.Root>
  );
}

const messageRows = { Message: ThreadMessageRow };

interface ThreadPaging {
  hasEarlier: boolean;
  isTruncated: boolean;
  isLoadingEarlier: boolean;
  loadEarlier: () => Promise<LoadEarlierResult>;
}

interface ThreadViewportProps {
  paging: ThreadPaging;
  notices: ReactNode;
  children: ReactNode;
}

function ThreadViewport({ paging, notices, children }: ThreadViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  // Observe the runtime's rendered order so anchoring runs after its message
  // list commits, even when the external store updates one render earlier.
  const firstId = useAuiState((state) => state.thread.messages[0]?.id);
  const onLoadEarlier = usePrependAnchor(viewportRef, firstId, paging.loadEarlier);
  const sentinelRef = useLoadEarlierSentinel({ ...paging, viewportRef, onLoadEarlier });

  return (
    <ThreadPrimitive.Viewport className="session-thread__viewport events" ref={viewportRef} autoScroll
      scrollToBottomOnRunStart={false}>
      {paging.hasEarlier ? (
        <div ref={sentinelRef} className="session-thread__sentinel">
          {paging.isLoadingEarlier && <span className="notice notice-muted">Loading earlier history…</span>}
        </div>
      ) : paging.isTruncated && (
        <div className="row row-system"><div className="notice notice-muted">Older history is no longer held</div></div>
      )}
      {notices}
      <ThreadPrimitive.Messages components={messageRows} />
      {children}
    </ThreadPrimitive.Viewport>
  );
}

interface SessionThreadProps extends ThreadViewportProps {
  session: ThreadSession;
  sendCallbacks: SendInputCallbacks;
}

export function SessionThread({ session, sendCallbacks, ...viewport }: SessionThreadProps) {
  const { sid } = session;
  const { send } = useSendInput(sid, sendCallbacks);
  const runtime = useSessionThreadRuntime(sid, send);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadSessionContext.Provider value={session}>
        <ThreadPrimitive.Root className="session-thread">
          <ThreadViewport {...viewport} />
        </ThreadPrimitive.Root>
      </ThreadSessionContext.Provider>
    </AssistantRuntimeProvider>
  );
}
