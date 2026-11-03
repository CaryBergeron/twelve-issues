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

async function callClaude(env, { system, prompt, maxTokens }) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'The writing engine is not set up yet.');
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, data?.error?.message || `Writing engine error (${res.status}).`);
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, model, usage: data.usage || {} };
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new HttpError(502, 'The writing engine returned an unreadable answer. Please try again.');
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { throw new HttpError(502, 'The writing engine returned an unreadable answer. Please try again.'); }
}

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
You plan a 12-issue series that a real reader would look forward to: every issue has one clear idea, a reason to open it, and a reason to click.
Rules:
- Use only facts, stories, names, and details found in the source material or customer answers. Never invent quotes, statistics, testimonials, prices, or credentials.
- No two issues may share the same angle. Mix formats across the year (story, how-to, behind the scenes, reader question, list, seasonal, myth vs fact, spotlight).
- For an author: build reader relationship and book sales without spoiling major plot twists. Follow the author's spoiler rule exactly, draw issue types from the content they said they are happy to share, steer calls to action toward their stated goals, and name only the stores they listed. For a business: be genuinely useful first and promotional second.
- If issues are monthly, tie topics to the month or season where it fits naturally.
- Plain language. No long dashes (use commas, colons, or periods instead).
Respond with JSON only, no commentary.`;

export async function planSeries(env, sub) {
  const labels = issueLabels(sub.settings);
  if (env.MOCK_AI === '1') return mockPlan(sub, labels);
  const prompt = `${describeInputs(sub)}

Issue labels in order: ${labels.join(', ')}

SOURCE MATERIAL (${sub.source_chars} characters total${sub.source_chars > BRIEF_SOURCE_CHARS ? ', sampled' : ''}):
<source>
${sampleText(sub.source_text || '(No document uploaded. Work from the customer answers above.)', BRIEF_SOURCE_CHARS)}
</source>

Return this JSON shape:
{
  "summary": "2 to 3 sentences on what this content is and who it serves",
  "audience": "who the newsletter readers are and what they care about",
  "voice": "how the newsletter should sound, with 3 short style rules",
  "key_material": ["15 to 25 specific facts, stories, examples, or lines from the source worth using"],
  "issues": [
    {"number": 1, "label": "${labels[0]}", "format": "story | how-to | list | etc", "theme": "short title", "angle": "the one idea of this issue", "notes": "specific details from the source to use", "cta": "what the reader should do at the end"}
  ]
}
The issues array must have exactly 12 items, numbered 1 to 12.`;
  const { text, model, usage } = await callClaude(env, { system: EDITOR_SYSTEM, prompt, maxTokens: 8000 });
  const brief = extractJson(text);
  if (!Array.isArray(brief.issues) || brief.issues.length < 12) throw new HttpError(502, 'The plan came back incomplete. Please try again.');
  brief.issues = brief.issues.slice(0, 12).map((it, i) => ({ ...it, number: i + 1, label: labels[i] }));
  return { brief, model, usage };
}

const WRITER_SYSTEM = `You are a senior newsletter writer at Twelve Issues. You write email newsletters people actually read.
Rules:
- Follow the series plan and voice exactly. Ground every claim in the brief or source excerpt. Never invent quotes, statistics, testimonials, prices, or credentials.
- Each issue: a subject line under 55 characters that earns the open (no clickbait, no ALL CAPS), preview text under 90 characters, a headline, and a body of 350 to 550 words in Markdown.
- Body structure: a hook in the first two sentences, short paragraphs, one subheading or a short list where it helps, and a warm sign-off line. End with a single clear call to action that matches the plan.
- Write in second person to the reader. Plain language, grade 7 to 8 reading level. No long dashes (use commas, colons, or periods instead). No emoji unless the voice calls for it.
- Do not mention that this was planned as a series of 12 or written by AI.
Respond with JSON only, no commentary.`;

export async function writeBatch(env, sub, brief, numbers) {
  if (env.MOCK_AI === '1') return mockIssues(sub, brief, numbers);
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

Return JSON:
{"issues": [{"number": n, "subject": "...", "preview_text": "...", "headline": "...", "body": "markdown", "cta": "button or link text", "image_idea": "one sentence describing a fitting image"}]}
Include exactly these issue numbers: ${numbers.join(', ')}.`;
  const { text, model, usage } = await callClaude(env, { system: WRITER_SYSTEM, prompt, maxTokens: 9000 });
  const out = extractJson(text);
  const issues = (out.issues || []).filter(i => numbers.includes(Number(i.number)));
  if (issues.length !== numbers.length) throw new HttpError(502, 'Some issues came back missing. Please try again.');
  return { issues, model, usage };
}

// ----- Mock mode for local testing (MOCK_AI=1) -----
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
      preview_text: 'A short preview line for testing the layout.',
      headline: `Issue ${n}: ${brief.issues[n - 1].theme}`,
      body: `Here is a sample opening for issue ${n}.\n\n## Why it matters\n\nShort paragraphs keep readers moving. This mock text checks layout, copy buttons, and downloads.\n\n- One useful point\n- Another useful point\n\nTalk soon,\nThe team`,
      cta: 'Read more',
      image_idea: 'A warm, simple photo that fits the topic.',
    })),
  };
}
