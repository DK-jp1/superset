import { cn } from "@superset/ui/utils";
import type { DoyDeckWorkerBindingSnapshot } from "renderer/stores/doydeck-worker-bindings";

export function CommanderHelperBar({
	activeTerminal,
	workerBinding,
	providerLabel,
	hasProvider,
}: {
	activeTerminal: string | null;
	workerBinding: DoyDeckWorkerBindingSnapshot;
	providerLabel: string;
	hasProvider: boolean;
}) {
	return (
		<div className="shrink-0">
			<div className="flex min-w-0 flex-wrap items-center gap-1 border-t px-1.5 py-0.5">
				<span
					className={cn(
						"shrink-0 rounded px-1 py-0.5 text-[9px] font-medium",
						hasProvider
							? "bg-primary/10 text-primary"
							: "bg-muted text-muted-foreground",
					)}
					data-testid="browser-provider-status"
				>
					{providerLabel}
				</span>
				<span
					className={cn(
						"shrink-0 rounded px-1 py-0.5 text-[9px] font-medium",
						activeTerminal
							? "bg-green-500/10 text-green-600 dark:text-green-400"
							: "bg-muted text-muted-foreground",
					)}
					data-testid="terminal-active-marker"
				>
					{activeTerminal ? "Term ✓" : "Term ✗"}
				</span>
				<span
					className={cn(
						"shrink-0 rounded px-1 py-0.5 text-[9px] font-medium",
						workerBinding.bindingStatus === "bound"
							? "bg-green-500/10 text-green-600 dark:text-green-400"
							: workerBinding.bindingStatus === "stale"
								? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
								: "bg-muted text-muted-foreground",
					)}
					data-testid="worker-binding-marker"
					title={workerBinding.reason ?? undefined}
				>
					Worker{" "}
					{workerBinding.bindingStatus === "bound"
						? "✓"
						: workerBinding.bindingStatus === "stale"
							? "!"
							: "-"}
				</span>
				<div className="min-w-0 flex-1" />
			</div>
		</div>
	);
}
