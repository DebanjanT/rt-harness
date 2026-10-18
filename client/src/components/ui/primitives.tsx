/**
 * Small set of styled primitives built on Radix UI + Tailwind.
 * Black/grey theme, semi-rounded — the design system for the whole app.
 */
import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

/* ---------------- Button ---------------- */

type ButtonVariant = "solid" | "ghost" | "outline" | "danger";
type ButtonSize = "xs" | "sm" | "md";

const variantClasses: Record<ButtonVariant, string> = {
  solid:
    "bg-zinc-200 text-zinc-950 hover:bg-zinc-100 active:bg-zinc-300 shadow-sm shadow-black/40",
  ghost: "bg-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200",
  outline:
    "border border-zinc-700/80 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100 hover:border-zinc-600",
  danger: "bg-red-500/90 text-white hover:bg-red-500",
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[11px] gap-1 rounded-md",
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-md",
  md: "h-8 px-3.5 text-[13px] gap-2 rounded-lg",
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(function Button({ variant = "outline", size = "sm", className = "", ...props }, ref) {
  return (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center font-medium transition-colors
        duration-100 outline-none focus-visible:ring-1 focus-visible:ring-zinc-500
        disabled:opacity-40 disabled:pointer-events-none select-none
        ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    />
  );
});

/* ---------------- Panel / header ---------------- */

export function Panel({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <div className={`flex flex-col min-h-0 ${className}`}>{children}</div>;
}

export function PanelHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-surface-2/80 px-3">
      <span className="text-[10px] font-semibold tracking-[0.14em] text-ink-3 uppercase">{title}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

/* ---------------- Dropdown (Radix) ---------------- */

export const Dropdown = DropdownMenuPrimitive.Root;
export const DropdownTrigger = DropdownMenuPrimitive.Trigger;

export function DropdownContent({
  children,
  align = "start",
}: {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        align={align}
        sideOffset={5}
        className="z-50 min-w-[220px] overflow-hidden rounded-lg border border-line-strong
          bg-surface-3 p-1 shadow-xl shadow-black/60
          [animation:fadeIn_120ms_ease-out]"
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownItem({
  selected,
  className = "",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { selected?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={`flex cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5
        text-xs outline-none transition-colors
        data-[highlighted]:bg-zinc-700/50 data-[highlighted]:text-zinc-100
        ${selected ? "text-zinc-100" : "text-zinc-400"} ${className}`}
      {...props}
    />
  );
}

export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenuPrimitive.Label className="px-2.5 pt-2 pb-1 text-[10px] font-semibold
      uppercase tracking-wider text-ink-3">
      {children}
    </DropdownMenuPrimitive.Label>
  );
}

/* ---------------- Switch (Radix) ---------------- */

export function LabeledSwitch({
  checked,
  onCheckedChange,
  label,
  tooltip,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  tooltip?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-ink-2 select-none">
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative h-[16px] w-[28px] shrink-0 cursor-pointer rounded-full
          border border-line-strong bg-zinc-800 transition-colors
          data-[state=checked]:border-zinc-500 data-[state=checked]:bg-zinc-300
          outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
      >
        <SwitchPrimitive.Thumb
          className="block h-[12px] w-[12px] translate-x-[2px] rounded-full bg-zinc-400
            shadow transition-transform data-[state=checked]:translate-x-[13px]
            data-[state=checked]:bg-zinc-900"
        />
      </SwitchPrimitive.Root>
      {tooltip ? (
        <Tooltip content={tooltip}>
          <span className="cursor-default">{label}</span>
        </Tooltip>
      ) : (
        <span>{label}</span>
      )}
    </label>
  );
}

/* ---------------- Tooltip (Radix) ---------------- */

export function Tooltip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-50 rounded-md border border-line-strong bg-zinc-900 px-2 py-1
              text-[11px] text-zinc-300 shadow-lg shadow-black/50"
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/* ---------------- ScrollArea (Radix) ---------------- */

export function ScrollArea({
  className = "",
  viewportClassName = "",
  children,
}: {
  className?: string;
  viewportClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <ScrollAreaPrimitive.Root className={`min-h-0 overflow-hidden ${className}`}>
      <ScrollAreaPrimitive.Viewport className={`h-full w-full ${viewportClassName}`}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none p-0.5 transition-colors"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-zinc-700/60 hover:bg-zinc-600" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}

/* ---------------- Separator / Badge ---------------- */

export function Separator({ className = "" }: { className?: string }) {
  return (
    <SeparatorPrimitive.Root
      className={`shrink-0 bg-line ${className}`}
      orientation="horizontal"
    />
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "green" | "red" | "amber";
  children: React.ReactNode;
}) {
  const tones = {
    neutral: "border-zinc-700 text-zinc-400 bg-zinc-800/50",
    green: "border-emerald-800/70 text-emerald-400 bg-emerald-950/40",
    red: "border-red-900/70 text-red-400 bg-red-950/40",
    amber: "border-amber-800/70 text-amber-400 bg-amber-950/40",
  };
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-px
      text-[10px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
