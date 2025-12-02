import homepage from "../index.html";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle API requests
    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
          status: 405,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        const body = await request.json();

        // Determine selection and candidate order
        const defaultModelMap = {
          grok: 'x-ai/grok-4.1-fast:free',
          gpt5: 'openai/gpt-4-turbo',
          gemini: 'gemini-2.5-flash'
        };

        const requested = body.chatbot || 'grok';

        // Determine initial candidate. If client sent 'auto', allow the client-chosen hint
        let initial = requested;
        const allBots = ['grok', 'gpt5', 'gemini'];
        if (requested === 'auto') {
          // prefer client's chosen model if provided, otherwise pick random
          initial = body.clientChosen && allBots.includes(body.clientChosen) ? body.clientChosen : allBots[Math.floor(Math.random() * allBots.length)];
        }

        // Build ordered candidates: when auto => start with initial then try others; when explicitly requested => only that one
        const candidates = requested === 'auto' ? [initial, ...allBots.filter(b => b !== initial)] : [initial];

        console.log('[START REQUEST]', { requested, initial, candidates, clientChosen: body.clientChosen, timestamp: new Date().toISOString() });

        // Try each candidate in turn until one returns a valid response
        let lastError = null;
        for (const candidate of candidates) {
          const model = body.model || defaultModelMap[candidate];

          // select key/provider
          let apiKey = null;
          let provider = 'openrouter';
          if (candidate === 'gemini') {
            apiKey = env.GEMINI_API_KEY;
            provider = 'gemini';
          } else if (candidate === 'gpt5') {
            apiKey = env.GPT5_API_KEY;
            provider = 'openrouter';
          } else {
            apiKey = env.GROK_API_KEY;
            provider = 'openrouter';
          }

          console.log('[ATTEMPT]', { requested: requested, trying: candidate, provider, model, hasKey: !!apiKey, timestamp: new Date().toISOString() });

          if (!apiKey) {
            lastError = { error: `API key missing for ${candidate}` };
            console.warn('[SKIP]', lastError);
              if (requested !== 'auto') {
                return new Response(JSON.stringify({ error: `API key missing for ${candidate}` }), { status: 502, headers: { 'Content-Type': 'application/json' } });
              }
              continue; // try next candidate
          }

          try {
            if (provider === 'gemini') {
              // Gemini request
              const userMessage = body.messages?.[0]?.content || '';
              const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: userMessage }] }] }),
              });

              const text = await geminiRes.text();
              console.log('[GEMINI ATTEMPT RESULT]', { candidate, status: geminiRes.status, len: text.length });

              if (!geminiRes.ok) {
                lastError = { status: geminiRes.status, body: text };
                console.warn('[GEMINI ERROR]', lastError);
                if (requested !== 'auto') {
                  return new Response(JSON.stringify({ error: 'Model error', detail: lastError }), { status: geminiRes.status, headers: { 'Content-Type': 'application/json' } });
                }
                continue; // try next when auto
              }

              // parse and transform
              let parsed;
              try {
                parsed = JSON.parse(text);
              } catch (e) {
                lastError = { error: 'Invalid JSON from Gemini', detail: text.substring(0, 300) };
                console.error('[GEMINI PARSE ERROR]', lastError);
                if (requested !== 'auto') {
                  return new Response(JSON.stringify({ error: 'Invalid response from Gemini', detail: lastError }), { status: 502, headers: { 'Content-Type': 'application/json' } });
                }
                continue;
              }

              const geminiContent = parsed.candidates?.[0]?.content?.parts?.[0]?.text || parsed?.output?.[0]?.content || '';
              const transformed = { choices: [{ message: { content: geminiContent } }] };
              return new Response(JSON.stringify(transformed), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            } else {
              // OpenRouter request
              const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, messages: body.messages || [] }),
              });

              const text = await orRes.text();
              console.log('[OPENROUTER ATTEMPT RESULT]', { candidate, status: orRes.status, len: text.length });

              if (!orRes.ok) {
                lastError = { status: orRes.status, body: text };
                console.warn('[OPENROUTER ERROR]', lastError);
                // If user explicitly requested this model, return error immediately instead of falling back
                if (requested !== 'auto') {
                  return new Response(JSON.stringify({ error: 'Model error', detail: lastError }), { status: orRes.status, headers: { 'Content-Type': 'application/json' } });
                }
                continue; // try next candidate when auto
              }

              let parsed;
              try {
                parsed = JSON.parse(text);
              } catch (e) {
                lastError = { error: 'Invalid JSON from OpenRouter', detail: text.substring(0, 300) };
                console.error('[OPENROUTER PARSE ERROR]', lastError);
                if (requested !== 'auto') {
                  return new Response(JSON.stringify({ error: 'Invalid response from OpenRouter', detail: lastError }), { status: 502, headers: { 'Content-Type': 'application/json' } });
                }
                continue;
              }

              // success
              return new Response(JSON.stringify(parsed), { status: orRes.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            }
          } catch (err) {
            lastError = { error: err.message };
            console.error('[REQUEST ERROR]', { candidate, err: err.message });
            // If explicit model requested, return error immediately
            if (requested !== 'auto') {
              return new Response(JSON.stringify({ error: 'Request error', detail: lastError }), { status: 502, headers: { 'Content-Type': 'application/json' } });
            }
            continue; // try next when auto
          }
        }

        // All candidates failed
        console.error('[ALL MODELS FAILED]', { candidates, lastError, timestamp: new Date().toISOString() });
        return new Response(JSON.stringify({ error: 'No response received or limit request.' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        console.error('[CATCH ERROR]', {
          error: err.message,
          stack: err.stack,
          timestamp: new Date().toISOString()
        });
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Serve HTML for root path
    return new Response(homepage, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
      },
    });
  },
};
