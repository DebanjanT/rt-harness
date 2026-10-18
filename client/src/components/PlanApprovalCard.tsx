import { useMemo } from "react";
import { useChatStore } from "../stores/chat";
import type { Segment } from "../stores/chat";
import { Button, Badge } from "./ui/primitives";

/**
 * Parse a plan message into ordered steps. Recognizes:
 *   1. Step text   /  1) Step text   /  Step 1: text
 *   - Step text    /  * Step text    /  [ ] Step text
 * Falls back to paragraph blocks when no list markers are found.
 */
export function parsePlanSteps(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trimEnd());
  const steps: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+[.)]\s+|[-*•]\s+(?:\[[ x]\]\s+)?|step\s*\d+\s*[:.)-]\s*)?(.+)/i);
    const body = m?.[1]?.trim();
    if (!body) continue;
    // skip headings / noise
    if (/^#+\s/.test(line) || /^(here('s| is)|the plan|plan:)/i.test(body) || body.length < 3) continue;
    steps.push(body.replace(/\*\*/g, ""));
  }
  return steps.length > 0 ? steps : [text.trim()];
}

/**
 * Rendered after a plan-mode response. Shows the parsed steps as a checklist
 * and — on Approve — hands the whole plan to the agent in agent mode.
 */
export function PlanApprovalCard({ entryIndex }: { entryIndex: number }) {
  const entries = useChatStore((s) => s.entries);
  const approvedIds = useChatStore((s) => s.approvedPlanIds);
  const markPlanApproved = useChatStore((s) => s.markPlanApproved);
  const setMode = useChatStore((s) => s.setMode);
  const send = useChatStore((s) => s.send);
  const running = useChatStore((s) => s.running);

  const entry = entries[entryIndex];
  const planText = (entry?.segments ?? [])
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");

  const steps = useMemo(() => parsePlanSteps(planText), [planText]);
  const planId = `plan-${entryIndex}`;
  const approved = approvedIds.includes(planId);

  const approve = () => {
    markPlanApproved(planId);
    setMode("agent");
    void send(
      "Approved. Execute this plan exactly, step by step. After each step, briefly state what was done.\n\n" +
        steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    );
  };

  return (
    <div className={`my-1 min-w-0 max-w-full overflow-hidden rounded-lg border p-2.5
      ${approved ? "border-emerald-900/60 bg-emerald-950/10" : "border-line-strong bg-surface-2/70"}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-200">
          📋 Plan — {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
        <Badge tone={approved ? "green" : "amber"}>{approved ? "approved" : "awaiting approval"}</Badge>
      </div>

      <ol className="mb-2 space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-ink-2">
            <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full
              bg-zinc-800 font-mono text-[9px] text-zinc-400">{i + 1}</span>
            <span className="min-w-0 break-words">{s}</span>
          </li>
        ))}
      </ol>

      {!approved && (
        <div className="flex gap-2">
          <Button variant="solid" size="sm" disabled={running} onClick={approve}>
            Approve &amp; run in agent mode
          </Button>
        </div>
      )}
    </div>
  );
}
