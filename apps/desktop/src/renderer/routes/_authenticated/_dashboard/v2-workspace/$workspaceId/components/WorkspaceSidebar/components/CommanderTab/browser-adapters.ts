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

const EXTRACTION_SCRIPTS: Record<BrowserProvider, string> = {
	chatgpt: `(function() {
  var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!msgs.length) {
    msgs = document.querySelectorAll('.agent-turn');
  }
  if (!msgs.length) return null;
  var last = msgs[msgs.length - 1];
  var md = last.querySelector('.markdown');
  return (md || last).innerText || null;
})()`,
	claude: `(function() {
  var msgs = document.querySelectorAll('div.font-claude-response');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText || null;
})()`,
	gemini: `(function() {
  var msgs = document.querySelectorAll('message-content');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText || null;
})()`,
};

export function buildExtractionScript(provider: BrowserProvider): string {
	return EXTRACTION_SCRIPTS[provider];
}

const SNAPSHOT_HELPER = `
function normalizeText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}
function fingerprintText(value) {
  var text = normalizeText(value);
  var hash = 0;
  for (var i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return text.length + ':' + Math.abs(hash).toString(36) + ':' + text.slice(0, 80);
}
function toSnapshot(nodes) {
  var list = Array.prototype.slice.call(nodes || []).filter(Boolean);
  var latestNode = list[list.length - 1] || null;
  var latestText = latestNode ? normalizeText(latestNode.innerText || latestNode.textContent || '') : '';
  return {
    assistantCount: list.length,
    latestText: latestText,
    latestFingerprint: fingerprintText(latestText)
  };
}`;

const ASSISTANT_SNAPSHOT_SCRIPTS: Record<BrowserProvider, string> = {
	chatgpt: `(function() {
  ${SNAPSHOT_HELPER}
  var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!msgs.length) {
    msgs = document.querySelectorAll('.agent-turn');
  }
  return toSnapshot(msgs);
})()`,
	claude: `(function() {
  ${SNAPSHOT_HELPER}
  return toSnapshot(document.querySelectorAll('div.font-claude-response'));
})()`,
	gemini: `(function() {
  ${SNAPSHOT_HELPER}
  return toSnapshot(document.querySelectorAll('message-content'));
})()`,
};

export function buildAssistantSnapshotScript(
	provider: BrowserProvider,
): string {
	return ASSISTANT_SNAPSHOT_SCRIPTS[provider];
}

const LATEST_REPLY_STATE_HELPER = `
function normalizeText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}
function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .replace(/[\\t ]+\\n/g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
}
function fingerprintText(value) {
  var text = normalizeText(value);
  var hash = 0;
  for (var i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return text.length + ':' + Math.abs(hash).toString(36) + ':' + text.slice(0, 80);
}
function isVisible(el) {
  if (!el) return false;
  var rect = el.getBoundingClientRect();
  var style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    !el.closest('[hidden], [aria-hidden="true"]');
}
function isResponseInProgress() {
  var busySelectors = [
    '[aria-busy="true"]',
    '[data-is-streaming="true"]',
    '[data-streaming="true"]',
    '.result-streaming',
    '.streaming'
  ];
  for (var i = 0; i < busySelectors.length; i++) {
    var busy = document.querySelector(busySelectors[i]);
    if (busy && isVisible(busy)) return true;
  }
  var stopSelectors = [
    '[data-testid="stop-button"]',
    '[data-testid="composer-stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
    'button[aria-label="Cancel"]'
  ];
  for (var j = 0; j < stopSelectors.length; j++) {
    var stop = document.querySelector(stopSelectors[j]);
    if (stop && isVisible(stop) && !stop.disabled) return true;
  }
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button[aria-label]'));
  for (var k = 0; k < buttons.length; k++) {
    var label = String(buttons[k].getAttribute('aria-label') || '');
    if (/stop|cancel|停止|中止|生成を停止/i.test(label) && isVisible(buttons[k]) && !buttons[k].disabled) {
      return true;
    }
  }
  return false;
}
function toLatestReplyState(nodes) {
  var list = Array.prototype.slice.call(nodes || []).filter(Boolean);
  var latestNode = list[list.length - 1] || null;
  var latestText = latestNode
    ? normalizeMultilineText(latestNode.innerText || latestNode.textContent || '')
    : '';
  return {
    assistantCount: list.length,
    latestText: latestText,
    latestFingerprint: fingerprintText(latestText),
    isResponding: isResponseInProgress()
  };
}`;

const LATEST_REPLY_STATE_SCRIPTS: Record<BrowserProvider, string> = {
	chatgpt: `(function() {
  ${LATEST_REPLY_STATE_HELPER}
  var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!msgs.length) {
    msgs = document.querySelectorAll('.agent-turn');
  }
  return toLatestReplyState(msgs);
})()`,
	claude: `(function() {
  ${LATEST_REPLY_STATE_HELPER}
  return toLatestReplyState(document.querySelectorAll('div.font-claude-response'));
})()`,
	gemini: `(function() {
  ${LATEST_REPLY_STATE_HELPER}
  return toLatestReplyState(document.querySelectorAll('message-content'));
})()`,
};

export function buildLatestReplyStateScript(
	provider: BrowserProvider,
): string {
	return LATEST_REPLY_STATE_SCRIPTS[provider];
}

const SUBMIT_SELECTORS: Record<BrowserProvider, string[]> = {
	chatgpt: [
		'button[data-testid="send-button"]',
		'button[data-testid="composer-send-button"]',
		'button[aria-label="Send prompt"]',
		'form button[type="submit"]',
	],
	claude: [
		'button[aria-label="Send Message"]',
		'button[aria-label="Send message"]',
		'fieldset button[type="button"]:last-of-type',
	],
	gemini: [
		'button[aria-label="Send message"]',
		"button.send-button",
		'button[mat-icon-button][aria-label="Send message"]',
	],
};

export function buildComposerReadinessScript(
	provider: BrowserProvider,
): string {
	const submitSelectors = JSON.stringify(SUBMIT_SELECTORS[provider]);
	return `(function() {
  var selectors = [
    '#prompt-textarea',
    '.ProseMirror[contenteditable="true"]',
    'rich-textarea .ql-editor',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea',
    'input[type="text"]'
  ];
  function isVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      !el.closest('[hidden], [aria-hidden="true"]');
  }
  function isEditable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('contenteditable') === 'false') return false;
    return Boolean(el.isContentEditable || el.matches('textarea,input'));
  }
  var composer = null;
  for (var i = 0; i < selectors.length; i++) {
    var candidate = document.querySelector(selectors[i]);
    if (candidate && isVisible(candidate)) {
      composer = candidate;
      break;
    }
  }
  var submitButton = null;
  var submitSelectors = ${submitSelectors};
  for (var j = 0; j < submitSelectors.length; j++) {
    submitButton = document.querySelector(submitSelectors[j]);
    if (submitButton && isVisible(submitButton)) break;
  }
  var composerFound = Boolean(composer);
  var composerVisible = Boolean(composer && isVisible(composer));
  var composerEditable = Boolean(composer && isEditable(composer));
  return {
    provider: ${JSON.stringify(provider)},
    composerFound: composerFound,
    composerVisible: composerVisible,
    composerEditable: composerEditable,
    submitButtonFound: Boolean(submitButton),
    submitButtonEnabled: Boolean(submitButton && !submitButton.disabled && submitButton.getAttribute('aria-disabled') !== 'true'),
    ready: Boolean(composerFound && composerVisible && composerEditable),
    reason: !composerFound
      ? 'composer not found'
      : !composerVisible
        ? 'composer not visible'
        : !composerEditable
          ? 'composer not editable'
          : 'composer ready'
  };
})()`;
}

export function buildInjectionWithSubmitScript(
	text: string,
	provider: BrowserProvider,
): string {
	const escaped = JSON.stringify(text);
	const submitSelectors = JSON.stringify(SUBMIT_SELECTORS[provider]);
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
  if (!el) return "not_found";
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
  return new Promise(function(resolve) {
    setTimeout(function() {
      var submitSelectors = ${submitSelectors};
      for (var i = 0; i < submitSelectors.length; i++) {
        var btn = document.querySelector(submitSelectors[i]);
        if (btn && !btn.disabled) {
          btn.click();
          resolve("submitted");
          return;
        }
      }
      resolve("injected");
    }, 300);
  });
})()`;
}
