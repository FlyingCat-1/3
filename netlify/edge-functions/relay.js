const DEFAULT_UPSTREAM_TIMEOUT_MS = 25000;

export default async (request, context) => {
    try {
        const hop = request.headers.get("x-relay-hop");
        const fwdHop = request.headers.get("x-fwd-hop");
        if (hop === "1" || fwdHop === "1") {
            return json({ e: "loop detected" }, 508);
        }

        if (request.method === "GET") {
            return json({ e: "Relay is Active." }, 200);
        }

        if (request.method !== "POST") {
            return json({ e: "Method not allowed." }, 405);
        }

        const req = await request.json();

        if (!req.u) {
            return json({ e: "missing url" }, 400);
        }

        const targetUrl = new URL(req.u);
        const requestUrl = new URL(request.url);

        // Dynamically block requests to the current Netlify deployment URL
        const BLOCKED_HOSTS = [
            requestUrl.hostname
        ];

        if (BLOCKED_HOSTS.some(h => targetUrl.hostname.endsWith(h))) {
            return json({ e: "self-fetch blocked" }, 400);
        }

        // Netlify exposes environment variables via Netlify.env
        const env = {
            UPSTREAM_FORWARDER_URL: Netlify.env.get("UPSTREAM_FORWARDER_URL") || "",
            UPSTREAM_FAIL_MODE: Netlify.env.get("UPSTREAM_FAIL_MODE") || "closed",
            UPSTREAM_TIMEOUT_MS: Netlify.env.get("UPSTREAM_TIMEOUT_MS") || "",
            UPSTREAM_AUTH_KEY: Netlify.env.get("UPSTREAM_AUTH_KEY") || ""
        };

        const upstreamUrl = env.UPSTREAM_FORWARDER_URL;
        const wantForward = (req.f === 1) || (req.f === undefined);

        if (upstreamUrl && wantForward) {
            const upstreamResp = await forwardViaUpstream(req, env, upstreamUrl, requestUrl.hostname);
            if (upstreamResp) return upstreamResp;
        }

        const headers = new Headers();
        if (req.h && typeof req.h === "object") {
            for (const [k, v] of Object.entries(req.h)) {
                headers.set(k, v);
            }
        }

        headers.set("x-relay-hop", "1");

        const fetchOptions = {
            method: (req.m || "GET").toUpperCase(),
            headers,
            redirect: req.r === false ? "manual" : "follow"
        };

        if (req.b) {
            fetchOptions.body = Uint8Array.from(atob(req.b), c => c.charCodeAt(0));
        }

        const resp = await fetch(targetUrl.toString(), fetchOptions);

        // Standard web API array buffer handling (safe chunking to prevent stack overflow)
        const buffer = await resp.arrayBuffer();
        const uint8 = new Uint8Array(buffer);

        let binary = "";
        const chunkSize = 0x8000; 

        for (let i = 0; i < uint8.length; i += chunkSize) {
            binary += String.fromCharCode.apply(
                null,
                uint8.subarray(i, i + chunkSize)
            );
        }

        const base64 = btoa(binary);

        const responseHeaders = {};
        resp.headers.forEach((v, k) => {
            responseHeaders[k] = v;
        });

        return json({
            s: resp.status,
            h: responseHeaders,
            b: base64
        });

    } catch (err) {
        return json({ e: String(err) }, 500);
    }
};

async function forwardViaUpstream(req, env, upstreamUrl, currentHostname) {
    const failMode = env.UPSTREAM_FAIL_MODE.toLowerCase();
    const timeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS, 10) || DEFAULT_UPSTREAM_TIMEOUT_MS;
    const authKey = env.UPSTREAM_AUTH_KEY;

    let parsed;
    try {
        parsed = new URL(upstreamUrl);
    } catch (_) {
        return upstreamFailure("invalid UPSTREAM_FORWARDER_URL", failMode);
    }
    if (parsed.protocol !== "https:") {
        return upstreamFailure("UPSTREAM_FORWARDER_URL must be https://", failMode);
    }
    if (parsed.hostname.endsWith(currentHostname)) {
        return upstreamFailure("self-forward blocked", failMode);
    }
    if (!authKey) {
        return upstreamFailure("UPSTREAM_AUTH_KEY missing", failMode);
    }

    const payload = {
        u: req.u,
        m: req.m,
        h: req.h,
        b: req.b,
        ct: req.ct,
        r: req.r
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const resp = await fetch(upstreamUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-upstream-auth": authKey
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!resp.ok) {
            return upstreamFailure("forwarder status " + resp.status, failMode);
        }

        const body = await resp.text();
        return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" }
        });
    } catch (err) {
        return upstreamFailure(String(err && err.message || err), failMode);
    } finally {
        clearTimeout(timer);
    }
}

function upstreamFailure(reason, failMode) {
    if (failMode === "open") {
        console.warn("upstream forwarder failed (falling back to direct):", reason);
        return null;
    }
    return json({ e: "upstream forwarder failed: " + reason }, 502);
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            "content-type": "application/json"
        }
    });
}
