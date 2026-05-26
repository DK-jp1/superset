import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface GitInitDialogState {
	isOpen: boolean;
	isPending: boolean;
	paths: string[];
	onConfirm: (() => void) | null;
	onCancel: (() => void) | null;
	/** DoyDeck: open the folder(s) as a project without git. */
	onOpenWithoutGit: (() => void) | null;
	open: (params: {
		paths: string[];
		onConfirm: () => void;
		onCancel: () => void;
		onOpenWithoutGit?: () => void;
	}) => void;
	setIsPending: (isPending: boolean) => void;
	close: () => void;
}

export const useGitInitDialogStore = create<GitInitDialogState>()(
	devtools(
		(set) => ({
			isOpen: false,
			isPending: false,
			paths: [],
			onConfirm: null,
			onCancel: null,
			onOpenWithoutGit: null,

			open: ({ paths, onConfirm, onCancel, onOpenWithoutGit }) => {
				set({
					isOpen: true,
					isPending: false,
					paths,
					onConfirm,
					onCancel,
					onOpenWithoutGit: onOpenWithoutGit ?? null,
				});
			},

			setIsPending: (isPending) => {
				set({ isPending });
			},

			close: () => {
				set({
					isOpen: false,
					isPending: false,
					paths: [],
					onConfirm: null,
					onCancel: null,
					onOpenWithoutGit: null,
				});
			},
		}),
		{ name: "GitInitDialogStore" },
	),
);
