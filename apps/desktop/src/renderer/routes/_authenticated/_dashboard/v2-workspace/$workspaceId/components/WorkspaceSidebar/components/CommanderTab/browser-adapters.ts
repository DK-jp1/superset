export type BrowserProvider = "chatgpt" | "claude" | "gemini";

const PROVIDER_HOSTS: Record<BrowserProvider, string[]> = {
	chatgpt: ["chatgpt.com", "chat.openai.com"],
	claude: ["claude.ai"],
	gemini: ["gemini.google.com"],
};

const PROVIDER_LABELS: Record<BrowserProvider, string> = {
	chatgpt: "ChatGPT",
	claude: "Claude",
	gemini: "Gemini",
};

export function detectProvider(url: string): BrowserProvider | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return null;
	}
	const hostname = parsed.hostname;
	for (const [provider, hosts] of Object.entries(PROVIDER_HOSTS)) {
		if (hosts.some((h) => hostname === h)) {
			return provider as BrowserProvider;
		}
	}
	return null;
}

export function getProviderLabel(provider: BrowserProvider | null): string {
	if (!provider) return "Unsupported";
	return PROVIDER_LABELS[provider];
}

export function buildInjectionScript(text: string): string {
	const escaped = JSON.stringify(text);
	return `(function() {
  var selectors = [
    '#prompt-textarea',
    '.ProseMirror[contenteditable="true"]',
    'rich-textarea .ql-editor',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"]'
  ];
  var el = null;
  for (var i = 0; i < selectors.length; i++) {
    el = document.querySelector(selectors[i]);
    if (el) break;
  }
  if (!el) return false;
  el.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  var ok = document.execCommand('insertText', false, ${escaped});
  if (!ok) {
    el.textContent = ${escaped};
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText',
      data: ${escaped},
      bubbles: true,
      composed: true
    }));
  }
  return true;
})()`;
}
