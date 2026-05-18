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
	const composerSelectors = JSON.stringify([
		...new Set(Object.values(COMPOSER_SELECTORS).flat()),
	]);
	return `(function() {
  ${COMPOSER_TARGET_HELPER}
  var composerTarget = findComposerTarget(${composerSelectors});
  var el = composerTarget.element;
  if (!el) return false;
  setComposerText(el, ${escaped});
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
		'button[aria-label="メッセージを送信"]',
		'button[aria-label*="送信"]',
		'button[aria-label*="send" i]',
		'button[aria-label="Send Message"]',
		'button[aria-label="Send message"]',
	],
	gemini: [
		'button[aria-label="Send message"]',
		"button.send-button",
		'button[mat-icon-button][aria-label="Send message"]',
	],
};

const COMPOSER_SELECTORS: Record<BrowserProvider, string[]> = {
	chatgpt: [
		'#prompt-textarea',
		'[data-testid="composer-text-input"]',
		'[contenteditable="true"][data-lexical-editor="true"]',
		'[role="textbox"][contenteditable="true"]',
		'.ProseMirror[contenteditable="true"]',
		'rich-textarea .ql-editor',
		'div.ql-editor[contenteditable="true"]',
		'textarea[placeholder*="Ask"]',
		'textarea[aria-label*="Ask"]',
		'textarea[placeholder*="Message"]',
		'textarea[aria-label*="Message"]',
	],
	claude: [
		'div[contenteditable="true"][aria-label*="Write"]',
		'div[contenteditable="true"][aria-label*="message"]',
		'[role="textbox"][contenteditable="true"]',
		'.ProseMirror[contenteditable="true"]',
		'fieldset div[contenteditable="true"]',
		'textarea[placeholder*="message"]',
		'textarea[aria-label*="message"]',
	],
	gemini: [
		'rich-textarea .ql-editor',
		'div.ql-editor[contenteditable="true"]',
		'div[contenteditable="true"][aria-label*="Enter"]',
		'[role="textbox"][contenteditable="true"]',
		'textarea[aria-label*="message"]',
	],
};

const USER_MESSAGE_SELECTORS: Record<BrowserProvider, string[]> = {
	chatgpt: [
		'[data-message-author-role="user"]',
		'[data-testid*="conversation-turn"][data-message-author-role="user"]',
	],
	claude: [
		'div.font-user-message',
		'[data-testid*="user"]',
		'[data-testid*="human"]',
		'[class*="user-message"]',
	],
	gemini: [
		"user-query",
		'[data-test-id*="user"]',
		'[class*="user-query"]',
		'[class*="user-message"]',
	],
};

const COMPOSER_TARGET_HELPER = `
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
  if (el.matches && el.matches('textarea,input')) return true;
  return Boolean(el.isContentEditable);
}
function describeElement(el) {
  if (!el) return '';
  var bits = [String(el.tagName || '').toLowerCase()];
  var id = el.getAttribute('id');
  var testId = el.getAttribute('data-testid');
  var aria = el.getAttribute('aria-label');
  var placeholder = el.getAttribute('placeholder');
  var className = typeof el.className === 'string' ? el.className : '';
  if (id) bits.push('#' + id);
  if (testId) bits.push('[data-testid="' + testId + '"]');
  if (aria) bits.push('[aria-label="' + aria + '"]');
  if (placeholder) bits.push('[placeholder="' + placeholder + '"]');
  if (className) bits.push('.' + className.replace(/\\s+/g, '.'));
  return bits.join('');
}
function likelyComposerTarget(el) {
  if (!el || !isVisible(el) || !isEditable(el)) return false;
  var haystack = [
    el.getAttribute('id'),
    el.getAttribute('data-testid'),
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('role'),
    typeof el.className === 'string' ? el.className : ''
  ].join(' ');
  if (/search|title|rename|filter|filename|filepath|path/i.test(haystack)) return false;
  return /prompt|composer|message|send|ask|chat|textbox|prosemirror|ql-editor|rich-textarea/i.test(haystack);
}
function findComposerTarget(selectors) {
  var checked = [];
  for (var i = 0; i < selectors.length; i++) {
    var selector = selectors[i];
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      checked.push(selector + ':' + describeElement(node));
      if (isVisible(node) && isEditable(node)) {
        return {
          element: node,
          selector: selector,
          checked: checked,
          status: 'ready',
          description: describeElement(node)
        };
      }
    }
  }
  var fallbackNodes = Array.prototype.slice.call(
    document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]')
  );
  for (var j = 0; j < fallbackNodes.length; j++) {
    var fallback = fallbackNodes[j];
    checked.push('fallback:' + describeElement(fallback));
    if (likelyComposerTarget(fallback)) {
      return {
        element: fallback,
        selector: 'fallback-likely-composer',
        checked: checked,
        status: 'ready',
        description: describeElement(fallback)
      };
    }
  }
  return {
    element: null,
    selector: null,
    checked: checked,
    status: checked.length ? 'not_editable_or_hidden' : 'not_found',
    description: ''
  };
}
function findSubmitTarget(selectors) {
  var checked = [];
  var disabledCandidate = null;
  for (var i = 0; i < selectors.length; i++) {
    var selector = selectors[i];
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      checked.push(selector + ':' + describeElement(node));
      if (!isVisible(node)) continue;
      var disabled = Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true');
      if (!disabled) {
        return {
          element: node,
          selector: selector,
          checked: checked,
          status: 'ready',
          description: describeElement(node)
        };
      }
      disabledCandidate = disabledCandidate || {
        element: node,
        selector: selector,
        checked: checked,
        status: 'disabled',
        description: describeElement(node)
      };
    }
  }
  if (disabledCandidate) return disabledCandidate;
  return {
    element: null,
    selector: null,
    checked: checked,
    status: checked.length ? 'hidden_or_disabled' : 'not_found',
    description: ''
  };
}
function setComposerText(el, text) {
  el.focus();
  if (el.matches && el.matches('textarea,input')) {
    var descriptor = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText',
      data: text,
      bubbles: true,
      composed: true
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  var ok = document.execCommand('insertText', false, text);
  if (!ok) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText',
      data: text,
      bubbles: true,
      composed: true
    }));
  }
  return true;
}`;

export function buildComposerReadinessScript(
	provider: BrowserProvider,
): string {
	const composerSelectors = JSON.stringify(COMPOSER_SELECTORS[provider]);
	const submitSelectors = JSON.stringify(SUBMIT_SELECTORS[provider]);
	return `(function() {
  ${COMPOSER_TARGET_HELPER}
  var composerTarget = findComposerTarget(${composerSelectors});
  var submitTarget = findSubmitTarget(${submitSelectors});
  var composer = composerTarget.element;
  var submitButton = submitTarget.element;
  var composerFound = Boolean(composer);
  var composerVisible = Boolean(composer && isVisible(composer));
  var composerEditable = Boolean(composer && isEditable(composer));
  var composerReady = Boolean(composerFound && composerVisible && composerEditable);
  var submitTargetReady = Boolean(submitButton && submitTarget.status === 'ready');
  var injectionBlockers = [];
  if (!composerReady) {
    injectionBlockers.push(
      composerTarget.status === 'not_found'
        ? 'composer injection target not found'
        : 'composer injection target not editable or visible'
    );
  }
  return {
    provider: ${JSON.stringify(provider)},
    composerFound: composerFound,
    composerVisible: composerVisible,
    composerEditable: composerEditable,
    submitButtonFound: Boolean(submitButton),
    submitButtonEnabled: submitTargetReady,
    composerReady: composerReady,
    composerInjectionReady: composerReady,
    submitTargetReady: submitTargetReady,
    composerSelectorStatus: composerTarget.selector || composerTarget.status,
    submitSelectorStatus: submitTarget.selector || submitTarget.status,
    injectionTargetStatus: composerReady ? 'ready' : composerTarget.status,
    injectionBlockers: injectionBlockers,
    ready: composerReady,
    reason: !composerFound
      ? 'composer injection target not found'
      : !composerVisible
        ? 'composer injection target not visible'
        : !composerEditable
          ? 'composer injection target not editable'
          : submitTargetReady
            ? 'composer and submit target ready'
            : 'composer injection target ready; submit target will be verified after insertion'
  };
})()`;
}

export function buildInjectionWithSubmitScript(
	text: string,
	provider: BrowserProvider,
): string {
	const escaped = JSON.stringify(text);
	const composerSelectors = JSON.stringify(COMPOSER_SELECTORS[provider]);
	const submitSelectors = JSON.stringify(SUBMIT_SELECTORS[provider]);
	return `(function() {
  ${COMPOSER_TARGET_HELPER}
  var composerTarget = findComposerTarget(${composerSelectors});
  var el = composerTarget.element;
  if (!el) return "not_found";
  setComposerText(el, ${escaped});
  return new Promise(function(resolve) {
    var attempts = 0;
    var submitSelectors = ${submitSelectors};
    function trySubmit() {
      var submitTarget = findSubmitTarget(submitSelectors);
      var btn = submitTarget.element;
      if (btn && submitTarget.status === 'ready') {
        btn.click();
        resolve("submitted");
        return;
      }
      attempts += 1;
      if (attempts < 10) {
        setTimeout(trySubmit, 250);
        return;
      }
      resolve("injected");
    }
    setTimeout(trySubmit, 250);
  });
})()`;
}

export function buildSubmissionReflectionStateScript(
	text: string,
	provider: BrowserProvider,
): string {
	const escaped = JSON.stringify(text);
	const composerSelectors = JSON.stringify(COMPOSER_SELECTORS[provider]);
	const userSelectors = JSON.stringify(USER_MESSAGE_SELECTORS[provider]);
	const assistantSelectors = JSON.stringify(
		provider === "chatgpt"
			? ['[data-message-author-role="assistant"]', ".agent-turn"]
			: provider === "claude"
				? ["div.font-claude-response"]
				: ["message-content"],
	);
	return `(function() {
  ${COMPOSER_TARGET_HELPER}
  var submittedPrompt = ${escaped};
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
  function getComposerText(el) {
    if (!el) return '';
    if (el.matches && el.matches('textarea,input')) {
      return String(el.value || '');
    }
    return normalizeMultilineText(el.innerText || el.textContent || '');
  }
  function collectVisibleTexts(selectors) {
    var seen = [];
    var texts = [];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[i]));
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (!node || seen.indexOf(node) !== -1 || !isVisible(node)) continue;
        seen.push(node);
        var text = normalizeMultilineText(node.innerText || node.textContent || '');
        if (text) texts.push(text);
      }
    }
    return texts;
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
  var normalizedPrompt = normalizeText(submittedPrompt);
  var promptFingerprint = fingerprintText(normalizedPrompt);
  var promptPrefix = normalizedPrompt.slice(0, Math.min(160, normalizedPrompt.length));
  var promptSuffix = normalizedPrompt.slice(Math.max(0, normalizedPrompt.length - 100));
  function matchesSubmittedPrompt(value) {
    var text = normalizeText(value);
    if (!text || !normalizedPrompt) return false;
    if (fingerprintText(text) === promptFingerprint) return true;
    if (normalizedPrompt.length <= 240 && text.indexOf(normalizedPrompt) !== -1) return true;
    if (promptPrefix.length >= 32 && text.indexOf(promptPrefix) !== -1) return true;
    if (promptSuffix.length >= 32 && text.indexOf(promptSuffix) !== -1) return true;
    return false;
  }
  var composerTarget = findComposerTarget(${composerSelectors});
  var composerText = getComposerText(composerTarget.element);
  var composerTextNormalized = normalizeText(composerText);
  var composerEmpty = composerTextNormalized.length === 0;
  var userTexts = collectVisibleTexts(${userSelectors});
  var latestUserText = userTexts[userTexts.length - 1] || '';
  var userMessageReflected = false;
  var reflectionReason = 'submitted prompt not found in visible user messages';
  for (var u = 0; u < userTexts.length; u++) {
    if (matchesSubmittedPrompt(userTexts[u])) {
      userMessageReflected = true;
      reflectionReason = 'submitted prompt matched visible user message';
      break;
    }
  }
  if (!userMessageReflected && composerEmpty && promptPrefix.length >= 32) {
    var bodyText = normalizeText(document.body ? document.body.innerText || document.body.textContent || '' : '');
    if (bodyText.indexOf(promptPrefix) !== -1) {
      userMessageReflected = true;
      reflectionReason = 'submitted prompt matched visible document after composer cleared';
    }
  }
  if (!userMessageReflected && !composerEmpty) {
    reflectionReason = 'composer still contains text after submit attempt';
  }
  var assistantTexts = collectVisibleTexts(${assistantSelectors});
  var latestAssistantText = assistantTexts[assistantTexts.length - 1] || '';
  return {
    visualVerificationUsed: true,
    userMessageCount: userTexts.length,
    latestUserMessageText: latestUserText,
    latestUserMessageFingerprint: fingerprintText(latestUserText),
    submittedPromptFingerprint: promptFingerprint,
    submittedPromptPreview: normalizedPrompt.slice(0, 240),
    userMessageReflected: userMessageReflected,
    reflectionReason: reflectionReason,
    composerEmpty: composerEmpty,
    composerTextLength: composerTextNormalized.length,
    composerTextPreview: composerTextNormalized.slice(0, 240),
    composerSelectorStatus: composerTarget.selector || composerTarget.status,
    assistantCount: assistantTexts.length,
    latestAssistantText: latestAssistantText,
    latestAssistantFingerprint: fingerprintText(latestAssistantText),
    isResponding: isResponseInProgress()
  };
})()`;
}
