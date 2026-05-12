let nativeFileDragActive = false;

export function setDoyDeckNativeFileDragActive(active: boolean): void {
	nativeFileDragActive = active;
}

export function isDoyDeckNativeFileDragActive(): boolean {
	return nativeFileDragActive;
}
