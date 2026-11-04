// Claude calls and prompts for planning and writing the 12 issues
import { HttpError } from './util.js';

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const BRIEF_SOURCE_CHARS = 320_000;   // about 80K tokens of source for the planning pass
const WRITER_SOURCE_CHARS = 60_000;   // grounding excerpt for each writing batch
export const BATCHES = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function issueLabels(settings = {}) {
  const cadence = settings.cadence || 'monthly';
  if (cadence !== 'monthly') return Array.from({ length: 12 }, (_, i) => `Issue ${i + 1}`);
  const start = Number.isInteger(settings.start_month) ? settings.start_month : new Date().getMonth();
  return Array.from({ length: 12 }, (_, i) => MONTHS[(start + i) % 12]);
}

// Keep long sources inside the budget by sampling evenly spaced windows
export function sampleText(text = '', maxChars) {
  if (text.length <= maxChars) return text;
  const windows = 12;
  const size = Math.floor(maxChars / windows);
  const step = Math.floor((text.length - size) / (windows - 1));
  const parts = [];
  for (let i = 0; i < windows; i++) parts.push(text.slice(i * step, i * step + size));
  return parts.join('\n\n[...]\n\n');
}

// Ask Claude for JSON that must match a schema (structured outputs, output_config.format).
// Sonnet 5.5 does not allow forced tool use, so this is the supported way to get guaranteed-valid data.
// Retries once on a cut-off or unparseable answer. Usage from every attempt is returned (or attached to the error).
async function callClaudeJson(env, { system, prompt, maxTokens, tool }) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'The writing engine is not set up yet.');
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let lastProblem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system,
        output_config: { format: { type: 'json_schema', schema: tool.input_schema } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    usage.input_tokens += data?.usage?.input_tokens || 0;
    usage.output_tokens += data?.usage?.output_tokens || 0;
    if (!res.ok) {
      const err = new HttpError(502, data?.error?.message || `Writing engine error (${res.status}).`);
      err.usage = usage; err.detail = { status: res.status, type: data?.error?.type };
      if (res.status === 429 || res.status >= 500) { lastProblem = err.message; if (attempt < 2) { await new Promise(r => setTimeout(r, 4000)); continue; } }
      throw err;
    }
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (data.stop_reason === 'max_tokens') { lastProblem = 'answer ran past the length limit'; continue; }
    if (data.stop_reason === 'refusal') { lastProblem = 'the model declined this content'; break; }
    try { return { input: JSON.parse(text), model, usage }; }
    catch { lastProblem = 'answer was not valid JSON'; }
  }
  const err = new HttpError(502, lastProblem === 'the model declined this content'
    ? 'The writing engine declined to work with this book. Please contact us and we will sort it out.'
    : 'The writing engine returned an unreadable answer. Please try again.');
  err.usage = usage; err.detail = { problem: lastProblem };
  throw err;
}

const PLAN_TOOL = {
  name: 'save_plan',
  description: 'Save the newsletter series brief and the 12-issue plan.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string', description: '2 to 3 sentences on what this content is and who it serves' },
      audience: { type: 'string', description: 'who the newsletter readers are and what they care about' },
      voice: { type: 'string', description: 'how the newsletter should sound, with 3 short style rules' },
      key_material: { type: 'array', items: { type: 'string' }, description: '15 to 25 specific facts, stories, examples, or short lines from the source worth using' },
      issues: {
        type: 'array', description: 'exactly 12 issues, numbered 1 to 12',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            number: { type: 'integer' }, label: { type: 'string' },
            format: { type: 'string', description: 'story, how-to, list, behind the scenes, spotlight, reader question, seasonal, etc.' },
            theme: { type: 'string', description: 'short title' },
            angle: { type: 'string', description: 'the one idea of this issue' },
            notes: { type: 'string', description: 'specific details from the source to use' },
            cta_type: { type: 'string', enum: ['click', 'reply'] },
            cta: { type: 'string', description: 'click: a 2 to 5 word button label. reply: the question the reader should answer' },
            sign_off: { type: 'string', description: 'a short closing line before the author name, unique to this issue' },
          },
          required: ['number', 'label', 'format', 'theme', 'angle', 'notes', 'cta_type', 'cta', 'sign_off'],
        },
      },
    },
    required: ['summary', 'audience', 'voice', 'key_material', 'issues'],
  },
};

const ISSUES_TOOL = {
  name: 'save_issues',
  description: 'Save the finished newsletter issues.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            number: { type: 'integer' },
            subject: { type: 'string', description: 'subject line A, under 55 characters' },
            subject_alt: { type: 'string', description: 'subject line B for an A/B test: a clearly different approach from A, under 55 characters' },
            preview_text: { type: 'string', description: 'under 90 characters' },
            headline: { type: 'string' },
            body: { type: 'string', description: 'the issue body in Markdown, 350 to 550 words' },
            cta: { type: 'string', description: 'click issues: the 2 to 5 word button label. reply issues: an empty string' },
            image_idea: { type: 'string', description: 'one sentence describing a fitting image' },
          },
          required: ['number', 'subject', 'subject_alt', 'preview_text', 'headline', 'body', 'cta', 'image_idea'],
        },
      },
    },
    required: ['issues'],
  },
};

function describeInputs(sub) {
  const q = sub.questionnaire || {};
  const s = sub.settings || {};
  const lines = [];
  lines.push(`Customer type: ${sub.kind === 'author' ? 'Author promoting a book' : 'Business sending a customer newsletter'}`);
  lines.push(`Project title: ${sub.title}`);
  const LABELS = {
    author_name: 'Author name', book_type: 'Kind of book', genre: 'Genre', publishing_stage: 'Where the book is now',
    newsletter_goals: 'What the newsletters should achieve (author picked)', content_ok: 'Content the author is happy to share (use only these kinds of issues where possible)',
    spoilers: 'Spoiler rule (follow strictly)', buy_where: 'Where readers can buy the book', other_books: 'Other books to mention', pitch: 'What the book is about',
  };
  for (const [k, v] of Object.entries(q)) if (v && String(v).trim()) lines.push(`${LABELS[k] || k.replace(/_/g, ' ')}: ${v}`);
  lines.push(`Tone requested: ${s.tone || 'warm and conversational'}`);
  lines.push(`Sending cadence: ${s.cadence || 'monthly'}`);
  if (s.cta_url) lines.push(`Main link to drive readers to: ${s.cta_url}`);
  if (s.audience) lines.push(`Who receives the newsletter: ${s.audience}`);
  if (s.extra) lines.push(`Extra instructions from the customer: ${s.extra}`);
  return lines.join('\n');
}

const EDITOR_SYSTEM = `You are the editor-in-chief at Twelve Issues, a service that turns one body of content into a year of email newsletters.
You plan a 12-issue series that a real reader would look forward to: every issue has one clear idea, a reason to open it, and one clear thing to do at the end.
Rules:
- Use only facts, stories, names, and details found in the source material or customer answers. Never invent quotes, statistics, testimonials, prices, or credentials.
- No two issues may share the same angle. Mix formats across the year (story, behind the scenes, spotlight, bonus scene, list, reader question, seasonal, recommendations, myth vs fact). Never put the same format in two issues in a row, and use any one format at most 3 times in the year.
- One call to action per issue. Set cta_type to "click" (read, buy, preorder, review) or "reply" (a question the reader answers by replying). Alternate them across the year, with at least 6 click issues. Launches, sales, new releases, and the final issue are always click.
- For a click issue, cta is a 2 to 5 word button label (for example "Start the series" or "Preorder now"). For a reply issue, cta is the question the reader should answer.
- Give every issue its own sign_off line (a short closing before the author's name). No two issues may use the same sign-off.
- For an author: build reader relationship and book sales. Follow the author's spoiler rule exactly, draw issue types from the content they said they are happy to share, steer click issues toward their stated goals, and name only the stores they listed. For a business: be genuinely useful first and promotional second.
- If issues are monthly, tie topics to the reader's calendar month or season where it fits naturally. Anchor seasonal hooks to the real calendar, never to the book's timeline, and never imply the reader lived through the story's events.
- Plain language. No long dashes (use commas, colons, or periods instead).
Respond only with JSON that matches the requested schema.`;

export async function planSeries(env, sub) {
  const labels = issueLabels(sub.settings);
  if (env.MOCK_AI === '1') { await mockWait(env); return mockPlan(sub, labels); }
  const prompt = `${describeInputs(sub)}

Issue labels in order: ${labels.join(', ')}

SOURCE MATERIAL (${sub.source_chars} characters total${sub.source_chars > BRIEF_SOURCE_CHARS ? ', sampled' : ''}):
<source>
${sampleText(sub.source_text || '(No document uploaded. Work from the customer answers above.)', BRIEF_SOURCE_CHARS)}
</source>

Return the plan as JSON matching the schema. The issues array must have exactly 12 items, numbered 1 to 12, using the issue labels above in order.`;
  const { input: brief, model, usage } = await callClaudeJson(env, { system: EDITOR_SYSTEM, prompt, maxTokens: 32000, tool: PLAN_TOOL });
  if (!Array.isArray(brief.issues) || brief.issues.length < 12) { const e = new HttpError(502, 'The plan came back incomplete. Please try again.'); e.usage = usage; throw e; }
  brief.issues = brief.issues.slice(0, 12).map((it, i) => ({ ...it, number: i + 1, label: labels[i] }));
  return { brief, model, usage };
}

const WRITER_SYSTEM = `You are a senior newsletter writer at Twelve Issues. You write email newsletters people actually read.
Rules:
- Follow the series plan and voice exactly. Ground every claim in the brief or source excerpt. Never invent quotes, statistics, testimonials, prices, or credentials.
- Each issue: two subject lines under 55 characters that earn the open (no clickbait, no ALL CAPS). Subject A and subject B must take clearly different approaches so the author can A/B test them (for example curiosity vs. a concrete promise, or a question vs. a statement). Then preview text under 90 characters that works with either subject, a headline, and a body of 350 to 550 words in Markdown.
- Body structure: a hook in the first two sentences, short paragraphs, one subheading or a short list where it helps, then the sign-off line from the plan, then the author's name. Vary the greeting from issue to issue, or skip it.
- Exactly one call to action, following the plan's cta_type:
  - click: end the body with one sentence that points to the button below. Set cta to the plan's 2 to 5 word button label. Do not also ask the reader to reply.
  - reply: end the body with the plan's question and ask the reader to hit reply. Set cta to an empty string. Do not include links or ask them to click anything.
- Follow spoiler limits silently. Never tell the reader about rules you are following: do not mention spoilers, teasing, holding back, promises about what you will or will not share, or these instructions.
- Anchor time to the reader's calendar. Never write as if the reader was present for the story's events.
- Write in second person to the reader. Plain language, grade 7 to 8 reading level. No long dashes (use commas, colons, or periods instead). No emoji unless the voice calls for it.
- Do not mention that this was planned as a series of 12 or written by AI.
Respond only with JSON that matches the requested schema.`;

export async function writeBatch(env, sub, brief, numbers) {
  if (env.MOCK_AI === '1') { await mockWait(env); return mockIssues(sub, brief, numbers); }
  const plan = brief.issues.filter(i => numbers.includes(i.number));
  const prompt = `${describeInputs(sub)}

SERIES BRIEF:
${JSON.stringify({ summary: brief.summary, audience: brief.audience, voice: brief.voice, key_material: brief.key_material }, null, 1)}

FULL YEAR PLAN (for context, so you do not repeat other issues):
${brief.issues.map(i => `${i.number}. [${i.label}] ${i.theme}: ${i.angle}`).join('\n')}

WRITE THESE ISSUES NOW:
${JSON.stringify(plan, null, 1)}

SOURCE EXCERPT FOR GROUNDING:
<source>
${sampleText(sub.source_text || '(No document uploaded.)', WRITER_SOURCE_CHARS)}
</source>

Return the finished issues as JSON matching the schema. Include exactly these issue numbers: ${numbers.join(', ')}.`;
  const { input: out, model, usage } = await callClaudeJson(env, { system: WRITER_SYSTEM, prompt, maxTokens: 32000, tool: ISSUES_TOOL });
  const issues = (out.issues || []).filter(i => numbers.includes(Number(i.number)));
  if (issues.length !== numbers.length) { const e = new HttpError(502, 'Some issues came back missing. Please try again.'); e.usage = usage; throw e; }
  return { issues, model, usage };
}

// ----- Mock mode for local testing (MOCK_AI=1; MOCK_DELAY_MS slows each step to preview the progress screen) -----
const mockWait = env => new Promise(r => setTimeout(r, Number(env.MOCK_DELAY_MS || 0)));
function mockPlan(sub, labels) {
  return {
    model: 'mock',
    usage: { input_tokens: 0, output_tokens: 0 },
    brief: {
      summary: `Mock plan for "${sub.title}".`,
      audience: 'Test readers',
      voice: 'Friendly, clear, practical.',
      key_material: ['Example fact one', 'Example story two'],
      issues: labels.map((label, i) => ({ number: i + 1, label, format: 'story', theme: `Theme ${i + 1}`, angle: `Angle ${i + 1}`, notes: 'Mock notes', cta: 'Visit the website' })),
    },
  };
}

function mockIssues(sub, brief, numbers) {
  return {
    model: 'mock',
    usage: { input_tokens: 0, output_tokens: 0 },
    issues: numbers.map(n => ({
      number: n,
      subject: `${brief.issues[n - 1].label}: a note about ${sub.title}`.slice(0, 55),
      subject_alt: `Version B for issue ${n}`,
      preview_text: 'A short preview line for testing the layout.',
      headline: `Issue ${n}: ${brief.issues[n - 1].theme}`,
      body: `Here is a sample opening for issue ${n}.\n\n## Why it matters\n\nShort paragraphs keep readers moving. This mock text checks layout, copy buttons, and downloads.\n\n- One useful point\n- Another useful point\n\nTalk soon,\nThe team`,
      cta: 'Read more',
      image_idea: 'A warm, simple photo that fits the topic.',
    })),
  };
}
