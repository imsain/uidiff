// Headless Chrome lifecycle plus screenshot / interaction / measurement over
// the DevTools Protocol. No dependencies: Node >= 21 has fetch and WebSocket.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, UiDiffError, readJson, writeJson } from './project.mjs';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * `CHROME_PATH` first: it is the convention Puppeteer and Lighthouse already
 * use, so anyone with an unusual install has almost certainly set it, and it
 * is the only workable answer for browsers installed via flatpak, nix, or a
 * per-user directory that no fixed list will ever contain.
 */
export function chromeBinary(configured) {
  const explicit = configured || process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new UiDiffError(`No Chrome at ${explicit}`);
    }
    return explicit;
  }
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!found) {
    throw new UiDiffError(
      `No Chrome/Chromium found. Looked in:\n  ` +
        `${CHROME_CANDIDATES.join('\n  ')}\n\n` +
        'Set CHROME_PATH, or "chromePath" in your uidiff config.'
    );
  }
  return found;
}

async function chromeVersion(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000)
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function chromeStatus(port) {
  const version = await chromeVersion(port);
  const state = readJson(join(artifactsDir(), 'state', 'chrome.json'));
  return {
    running: !!version,
    port,
    browser: version?.Browser,
    pid: state?.pid
  };
}

/**
 * Starts Chrome detached so it outlives this CLI process — and, importantly,
 * outlives the shell command that invoked it. A backgrounded `chrome &` inside
 * an agent shell call is killed when that call returns.
 */
export async function ensureChrome(port, chromePath) {
  if (await chromeVersion(port)) {
    return { started: false, port };
  }
  const profile = join(artifactsDir(), 'state', 'chrome-profile');
  const child = spawn(
    chromeBinary(chromePath),
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank'
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  writeJson(join(artifactsDir(), 'state', 'chrome.json'), {
    pid: child.pid,
    port
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    if (await chromeVersion(port)) {
      return { started: true, port, pid: child.pid };
    }
  }
  throw new UiDiffError(`Chrome did not open a debugging port on ${port}`);
}

export async function openPage(port) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT'
  }).then((response) => response.json());
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener('open', done);
    socket.addEventListener('error', () =>
      fail(new UiDiffError('CDP socket failed'))
    );
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        fail(
          new UiDiffError(
            `${message.method ?? 'CDP'}: ${message.error.message}`
          )
        );
      } else {
        done(message.result);
      }
      return;
    }
    for (const listener of listeners) {
      listener(message);
    }
  });

  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = (nextId += 1);
      pending.set(id, { done, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (exceptionDetails) {
      throw new UiDiffError(
        exceptionDetails.exception?.description ?? exceptionDetails.text
      );
    }
    return result.value;
  };

  const waitForEvent = (method, timeoutMs = 30000) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        fail(new UiDiffError(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = (message) => {
        if (message.method === method) {
          clearTimeout(timer);
          listeners.delete(listener);
          done();
        }
      };
      listeners.add(listener);
    });

  return {
    send,
    evaluate,
    waitForEvent,
    /** Subscribes to a CDP event; returns an unsubscribe function. */
    on: (method, handler) => {
      const listener = (message) => {
        if (message.method === method) {
          handler(message.params);
        }
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {
      try {
        await send('Target.closeTarget', { targetId: target.id });
      } catch {
        // Page may already be gone.
      }
      socket.close();
    }
  };
}

async function runSteps(page, steps) {
  for (const step of steps) {
    if (step.wait) {
      await sleep(step.wait);
    } else if (step.waitFor) {
      const deadline = Date.now() + (step.timeout ?? 20000);
      while (
        !(await page.evaluate(
          `!!document.querySelector(${JSON.stringify(step.waitFor)})`
        ))
      ) {
        if (Date.now() > deadline) {
          throw new UiDiffError(
            `Timed out waiting for selector: ${step.waitFor}`
          );
        }
        await sleep(250);
      }
    } else if (step.click) {
      const clicked = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(step.click)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!clicked) {
        throw new UiDiffError(`Click target not found: ${step.click}`);
      }
      await sleep(step.after ?? 700);
    } else if (step.hover) {
      const point = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(step.hover)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) {
        throw new UiDiffError(`Hover target not found: ${step.hover}`);
      }
      // A real CDP mouse move: Radix and friends ignore synthetic DOM events.
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        pointerType: 'mouse'
      });
      await sleep(step.after ?? 700);
    } else {
      throw new UiDiffError(`Unrecognised step: ${JSON.stringify(step)}`);
    }
  }
}

async function measureSelectors(page, measure) {
  const entries = Object.entries(measure);
  if (entries.length === 0) {
    return {};
  }
  const spec = JSON.stringify(entries);
  return page.evaluate(`(() => {
    const round = (n) => Math.round(n * 10) / 10;
    const out = {};
    for (const [name, selector] of ${spec}) {
      const nodes = [...document.querySelectorAll(selector)];
      out[name] = nodes.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: round(r.x), y: round(r.y),
          w: round(r.width), h: round(r.height),
          cx: round(r.x + r.width / 2), cy: round(r.y + r.height / 2)
        };
      });
    }
    return out;
  })()`);
}

/**
 * Brings the page to a state that two separate captures can agree on.
 *
 * Everything here is a source of difference that has nothing to do with the
 * code change: an entry animation caught at a different moment, a web font
 * that had not swapped in yet, a lazy image still decoding, a blinking caret.
 * Left alone they turn up as real-looking pixel changes, and the old remedy
 * was to sleep for twelve seconds and hope.
 *
 * Animations are *finished* rather than disabled. Disabling them is the
 * obvious move and it is wrong: an element whose base style is `opacity: 0`
 * and which animates to 1 stays invisible, so the screenshot silently loses
 * content. Running ones are jumped to their end state instead, and the ones
 * that never end — spinners — are pinned to their first frame.
 */
const STABILISE = `(async () => {
  const style = document.getElementById('uidiff-stabilise') ??
    document.head.appendChild(Object.assign(document.createElement('style'), {
      id: 'uidiff-stabilise'
    }));
  style.textContent = '*, *::before, *::after {' +
    'transition-duration: 0s !important;' +
    'transition-delay: 0s !important;' +
    'animation-delay: 0s !important;' +
    'caret-color: transparent !important;' +
    'scroll-behavior: auto !important;' +
  '}';

  let pinned = 0;
  let finished = 0;
  for (const animation of document.getAnimations()) {
    const iterations = animation.effect?.getTiming?.().iterations;
    if (iterations === Infinity) {
      animation.currentTime = 0;
      animation.pause();
      pinned += 1;
    } else {
      try {
        animation.finish();
        finished += 1;
      } catch {
        // Not finishable — an unresolved or zero-duration effect.
      }
    }
  }

  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  const images = [...document.images].filter((image) => !image.complete);
  await Promise.all(images.map((image) => image.decode().catch(() => {})));

  return { pinned, finished, fonts: document.fonts?.status, images: images.length };
})()`;

/**
 * Waits for the page to stop fetching, then for one clear stretch of quiet.
 *
 * `settleMs` used to be spent in full on every capture. Here it is a budget
 * rather than a duration: a page that goes quiet in 800ms costs 800ms, and
 * one that never does — long-polling, a websocket, an analytics beacon —
 * still gives up exactly where the old sleep would have.
 */
async function waitForQuiet(page, { budgetMs, quietMs = 400 }) {
  let inFlight = 0;
  let lastActivity = Date.now();
  const started = Date.now();

  const track = (delta) => {
    inFlight = Math.max(0, inFlight + delta);
    lastActivity = Date.now();
  };
  const unsubscribe = [
    page.on('Network.requestWillBeSent', () => track(1)),
    page.on('Network.loadingFinished', () => track(-1)),
    page.on('Network.loadingFailed', () => track(-1))
  ];

  try {
    while (Date.now() - started < budgetMs) {
      if (inFlight === 0 && Date.now() - lastActivity >= quietMs) {
        return { quiet: true, waitedMs: Date.now() - started };
      }
      await sleep(100);
    }
    return { quiet: false, waitedMs: Date.now() - started };
  } finally {
    for (const stop of unsubscribe) {
      stop();
    }
  }
}

/**
 * Chrome cannot rasterise beyond roughly 16384 device pixels in either
 * direction, and asks for the whole page in device pixels once `scale` is
 * applied. Past that it returns a truncated or blank image, so the height is
 * capped here where it can be said out loud instead.
 */
const MAX_DEVICE_PIXELS = 16384;

/**
 * Overlays that mean the page failed rather than rendered.
 *
 * `host::shadow inner` looks inside a shadow root, which Next needs: it puts
 * `nextjs-portal` on *every* dev page as the collapsed devtools badge, so the
 * element proves nothing and only the dialog within it is a signal.
 *
 * This list is a supplement, not the mechanism. Anything not named here is
 * still caught by the response status, which needs no per-framework knowledge
 * — a 500 is a 500 in every language.
 */
export const DEFAULT_ERROR_SELECTORS = [
  'nextjs-portal::shadow [data-nextjs-dialog]',
  'vite-error-overlay'
];

function errorProbe(selectors) {
  return `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const showing = selectors.some((selector) => {
    const [host, inner] = selector.split('::shadow');
    const node = document.querySelector(host.trim());
    if (!node) return false;
    return inner ? !!node.shadowRoot?.querySelector(inner.trim()) : true;
  });
  if (!showing) return null;
  const text = document.body.innerText.replace(/\\s+/g, ' ').trim();
  return text.slice(0, 160) || 'the page rendered no text';
})()`;
}

/**
 * Splits a cookie header value into its pairs. Only the first pair used to be
 * set, so an app needing a session cookie *and* a CSRF cookie could not
 * authenticate at all.
 */
export function parseCookies(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const index = pair.indexOf('=');
      return {
        name: pair.slice(0, index).trim(),
        value: pair.slice(index + 1).trim()
      };
    })
    .filter((cookie) => cookie.name);
}

/**
 * Navigates, runs the requested interaction steps, writes a PNG, and returns
 * the measured element rects.
 */
export async function capture({
  port,
  url,
  outFile,
  viewport,
  steps,
  measure,
  cookie,
  errorSelectors = DEFAULT_ERROR_SELECTORS,
  settleMs,
  fullPage = false
}) {
  const page = await openPage(port);
  try {
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    // The two frames are the same URL fetched twice, a few seconds apart, from
    // a browser profile that outlives the run. Anything Chrome is willing to
    // serve from cache — a stylesheet, an image, a font, or the document
    // itself on a server that sets no cache headers — comes back identical by
    // construction, and the comparison reports that nothing changed.
    await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile ?? false
    });
    // Before navigating, so an app that respects the preference renders its
    // reduced variant rather than being frozen mid-motion afterwards.
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });

    for (const { name, value } of parseCookies(cookie)) {
      const isHostPrefixed = name.startsWith('__Host-');
      await page.send('Network.setCookie', {
        name,
        value,
        ...(isHostPrefixed ? {} : { domain: new URL(url).hostname }),
        path: '/',
        secure: name.startsWith('__Secure-') || isHostPrefixed,
        url
      });
    }

    // Collected for every document response, then narrowed to the main frame
    // once the navigation reports which frame that was. Keeping them all is
    // what makes redirects work: the last response for the frame is the page
    // actually shown, not the 302 that led to it.
    const documents = [];
    const stopWatching = page.on('Network.responseReceived', (params) => {
      if (params.type === 'Document') {
        documents.push({
          frameId: params.frameId,
          status: params.response.status
        });
      }
    });

    const loaded = page.waitForEvent('Page.loadEventFired');
    const { frameId } = await page.send('Page.navigate', { url });
    await loaded;
    const settled = await waitForQuiet(page, { budgetMs: settleMs });
    stopWatching();

    const status = documents.findLast((doc) => doc.frameId === frameId)?.status;
    const finalUrl = await page.evaluate('location.href');
    await runSteps(page, steps);
    const measurements = await measureSelectors(page, measure);
    // After the steps, so a click that breaks the page is caught too.
    const devError = await page.evaluate(errorProbe(errorSelectors));
    // Last, so anything a click or hover started is settled as well.
    const stabilised = await page.evaluate(STABILISE);

    let height = viewport.height;
    let clamped = null;
    if (fullPage) {
      const { cssContentSize } = await page.send('Page.getLayoutMetrics');
      const limit = Math.floor(MAX_DEVICE_PIXELS / viewport.scale);
      height = Math.max(viewport.height, Math.ceil(cssContentSize.height));
      if (height > limit) {
        clamped = { asked: height, taken: limit };
        height = limit;
      }
    }

    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: viewport.width, height, scale: viewport.scale }
    });
    writeFileSync(outFile, Buffer.from(data, 'base64'));
    return {
      measurements,
      finalUrl,
      devError,
      status,
      settled,
      stabilised,
      clamped,
      // CSS pixels, which is what a crop geometry is derived against.
      captured: { width: viewport.width, height }
    };
  } finally {
    await page.close();
  }
}
