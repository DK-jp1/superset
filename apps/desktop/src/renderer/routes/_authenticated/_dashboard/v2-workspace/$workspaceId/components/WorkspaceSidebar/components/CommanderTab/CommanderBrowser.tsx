import { Button } from "@superset/ui/button";
import { useEffect, useState } from "react";
import {
	LuArrowLeft,
	LuArrowRight,
	LuLoader,
	LuRefreshCw,
} from "react-icons/lu";
import { AI_PRESETS } from "./commander-types";

function BrowserToolbar({
	currentUrl,
	isLoading,
	canGoBack,
	canGoForward,
	onGoBack,
	onGoForward,
	onReload,
	onNavigate,
}: {
	currentUrl: string;
	isLoading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	onGoBack: () => void;
	onGoForward: () => void;
	onReload: () => void;
	onNavigate: (url: string) => void;
}) {
	const [editingUrl, setEditingUrl] = useState(currentUrl);
	const [isFocused, setIsFocused] = useState(false);

	useEffect(() => {
		if (!isFocused) setEditingUrl(currentUrl);
	}, [currentUrl, isFocused]);

	return (
		<div className="flex items-center gap-1 px-1.5 py-1 border-b shrink-0">
			<button
				type="button"
				onClick={onGoBack}
				disabled={!canGoBack}
				className="p-0.5 rounded hover:bg-accent disabled:opacity-30"
			>
				<LuArrowLeft className="size-3" />
			</button>
			<button
				type="button"
				onClick={onGoForward}
				disabled={!canGoForward}
				className="p-0.5 rounded hover:bg-accent disabled:opacity-30"
			>
				<LuArrowRight className="size-3" />
			</button>
			<button
				type="button"
				onClick={onReload}
				className="p-0.5 rounded hover:bg-accent"
			>
				{isLoading ? (
					<LuLoader className="size-3 animate-spin" />
				) : (
					<LuRefreshCw className="size-3" />
				)}
			</button>
			<form
				className="flex-1 min-w-0"
				onSubmit={(e) => {
					e.preventDefault();
					const trimmed = editingUrl.trim();
					if (trimmed) onNavigate(trimmed);
					setIsFocused(false);
				}}
			>
				<input
					type="text"
					value={editingUrl}
					onChange={(e) => setEditingUrl(e.target.value)}
					onFocus={() => {
						setIsFocused(true);
						setEditingUrl(currentUrl);
					}}
					onBlur={() => {
						setIsFocused(false);
						setEditingUrl(currentUrl);
					}}
					placeholder="URL を入力..."
					className="w-full text-[10px] bg-muted/50 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring truncate"
				/>
			</form>
		</div>
	);
}

export function CommanderBrowser({
	currentUrl,
	isLoading,
	canGoBack,
	canGoForward,
	containerRef,
	onGoBack,
	onGoForward,
	onReload,
	onNavigate,
}: {
	currentUrl: string;
	isLoading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	containerRef: React.RefObject<HTMLDivElement | null>;
	onGoBack: () => void;
	onGoForward: () => void;
	onReload: () => void;
	onNavigate: (url: string) => void;
}) {
	const isBlank = !currentUrl || currentUrl === "about:blank";

	return (
		<>
			<BrowserToolbar
				currentUrl={currentUrl}
				isLoading={isLoading}
				canGoBack={canGoBack}
				canGoForward={canGoForward}
				onGoBack={onGoBack}
				onGoForward={onGoForward}
				onReload={onReload}
				onNavigate={onNavigate}
			/>
			<div className="flex gap-1 px-1.5 py-1 border-b shrink-0">
				{AI_PRESETS.map((p) => (
					<Button
						key={p.label}
						variant="outline"
						size="sm"
						className="h-5 text-[10px] px-1.5"
						onClick={() => onNavigate(p.url)}
					>
						{p.label}
					</Button>
				))}
			</div>
			<div
				className="flex-1 min-h-0 relative"
				data-testid="commander-browser-area"
			>
				<div ref={containerRef} className="absolute inset-0" />
				{isBlank && (
					<div className="absolute inset-0 flex items-center justify-center bg-background z-10">
						<div className="text-center space-y-3 px-4">
							<p className="text-xs text-muted-foreground leading-relaxed">
								AI アシスタントを選択して
								<br />
								壁打ちを開始
							</p>
							<div className="flex flex-col gap-1.5">
								{AI_PRESETS.map((p) => (
									<Button
										key={p.label}
										variant="outline"
										size="sm"
										className="text-xs"
										onClick={() => onNavigate(p.url)}
									>
										{p.label}
									</Button>
								))}
							</div>
							<p className="text-[10px] text-muted-foreground">
								Form タブで文脈を設定 → Worker/Review をコピー
							</p>
						</div>
					</div>
				)}
			</div>
		</>
	);
}
