// Share timeout cancellation so independent panels do not grow competing cleanup rules.
export function cancelTimer(timer: NodeJS.Timeout | undefined): void {
	if (timer) clearTimeout(timer);
}
