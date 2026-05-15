const DOYDECK_EXPLORER_NAVIGATE_EVENT = "doydeck:explorer:navigate-path";

interface DoyDeckExplorerNavigateEventDetail {
	workspaceId: string;
	path: string;
}

type DoyDeckExplorerNavigator = (path: string) => void | Promise<void>;
type DoyDeckExplorerNavigationListener = (path: string) => void;

const navigators = new Map<string, DoyDeckExplorerNavigator>();
const pendingPaths = new Map<string, string>();

function isBrowserEnvironment() {
	return typeof window !== "undefined";
}

function dispatchNavigationRequest(workspaceId: string, path: string) {
	if (!isBrowserEnvironment()) return;
	window.dispatchEvent(
		new CustomEvent<DoyDeckExplorerNavigateEventDetail>(
			DOYDECK_EXPLORER_NAVIGATE_EVENT,
			{ detail: { workspaceId, path } },
		),
	);
}

function runNavigator(workspaceId: string, path: string) {
	const navigator = navigators.get(workspaceId);
	if (!navigator) return false;
	pendingPaths.delete(workspaceId);
	void navigator(path);
	return true;
}

export function registerDoyDeckExplorerPathNavigator(
	workspaceId: string | null | undefined,
	navigator: DoyDeckExplorerNavigator,
) {
	if (!workspaceId) return () => {};
	navigators.set(workspaceId, navigator);
	const pendingPath = pendingPaths.get(workspaceId);
	if (pendingPath) {
		window.setTimeout(() => runNavigator(workspaceId, pendingPath), 0);
	}
	return () => {
		if (navigators.get(workspaceId) === navigator) {
			navigators.delete(workspaceId);
		}
	};
}

export function requestDoyDeckExplorerPathNavigation(
	workspaceId: string | null | undefined,
	path: string,
) {
	if (!workspaceId || !path.trim()) return false;
	const requestedPath = path.trim();
	pendingPaths.set(workspaceId, requestedPath);
	if (runNavigator(workspaceId, requestedPath)) return true;
	dispatchNavigationRequest(workspaceId, requestedPath);
	return true;
}

export function subscribeDoyDeckExplorerNavigationRequests(
	workspaceId: string | null | undefined,
	listener: DoyDeckExplorerNavigationListener,
) {
	if (!workspaceId || !isBrowserEnvironment()) return () => {};

	const handleNavigate = (event: Event) => {
		const detail = (event as CustomEvent<DoyDeckExplorerNavigateEventDetail>)
			.detail;
		if (!detail || detail.workspaceId !== workspaceId) return;
		pendingPaths.set(detail.workspaceId, detail.path);
		if (runNavigator(detail.workspaceId, detail.path)) return;
		listener(detail.path);
	};

	window.addEventListener(DOYDECK_EXPLORER_NAVIGATE_EVENT, handleNavigate);
	return () =>
		window.removeEventListener(DOYDECK_EXPLORER_NAVIGATE_EVENT, handleNavigate);
}
