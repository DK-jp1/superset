import { useEffect } from "react";

const DOYDECK_CLOSE_DROPDOWNS_EVENT = "doydeck:close-dropdowns";

export function requestDoyDeckDropdownClose(): void {
	window.dispatchEvent(new CustomEvent(DOYDECK_CLOSE_DROPDOWNS_EVENT));
}

export function useDoyDeckDropdownClose(handler: () => void): void {
	useEffect(() => {
		window.addEventListener(DOYDECK_CLOSE_DROPDOWNS_EVENT, handler);
		return () =>
			window.removeEventListener(DOYDECK_CLOSE_DROPDOWNS_EVENT, handler);
	}, [handler]);
}
