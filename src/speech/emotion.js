/**
 * Map a plain emotion word onto a CosyVoice3 instruction.
 *
 * The model reads everything after `<|endofprompt|>` as text to speak, so an
 * instruction must end with the marker and carry nothing behind it. Only the
 * local CosyVoice3 voice understands these; the hosted voices ignore them.
 */

const PREFIX = 'You are a helpful assistant. ';
const MARK = '<|endofprompt|>';

const INSTRUCTIONS = {
  happy: '请非常开心地说这句话。',
  excited: '请用非常兴奋的语气说这句话，语速快一点。',
  angry: '请非常生气地说这句话，语速快一点。',
  sad: '请非常伤心、委屈地说这句话，声音轻一点。',
  crying: '请带着哭腔说这句话，声音发颤，快要忍不住了。',
  coquettish: '请用撒娇的语气说这句话，声音软一点。',
  shy: '请用害羞、小声的语气说这句话。',
  scared: '请用害怕、发抖的语气说这句话。',
  tired: '请用很累、有气无力的语气说这句话，语速慢一点。',
  teasing: '请用调侃、带点挑衅的语气说这句话。',
  contempt: '请用很不屑、冷淡的语气说这句话。',
  serious: '请用严肃、正式的语气说这句话。',
  sigh: '请先轻轻叹一口气，再说这句话。',
  soft: 'Please say this sentence in a very soft voice.',
  loud: 'Please say this sentence as loudly as possible.',
  slow: '请用尽可能慢的语速说一句话。',
  fast: '请用尽可能快的语速说一句话。',
  sichuan: '请用四川话说这句话。',
  cantonese: '请用广东话说这句话。',
  northeast: '请用东北话说这句话。',
};

const ALIASES = {
  开心: 'happy',
  高兴: 'happy',
  兴奋: 'excited',
  激动: 'excited',
  生气: 'angry',
  愤怒: 'angry',
  不耐烦: 'angry',
  难过: 'sad',
  伤心: 'sad',
  委屈: 'sad',
  低落: 'sad',
  哭: 'crying',
  哭腔: 'crying',
  哽咽: 'crying',
  撒娇: 'coquettish',
  可怜: 'coquettish',
  害羞: 'shy',
  脸红: 'shy',
  害怕: 'scared',
  恐惧: 'scared',
  累: 'tired',
  疲惫: 'tired',
  有气无力: 'tired',
  调侃: 'teasing',
  欠揍: 'teasing',
  挑衅: 'teasing',
  不屑: 'contempt',
  冷淡: 'contempt',
  严肃: 'serious',
  正经: 'serious',
  叹气: 'sigh',
  轻声: 'soft',
  悄悄: 'soft',
  温柔: 'soft',
  小声: 'soft',
  大声: 'loud',
  喊: 'loud',
  慢: 'slow',
  快: 'fast',
  四川: 'sichuan',
  四川话: 'sichuan',
  广东: 'cantonese',
  广东话: 'cantonese',
  粤语: 'cantonese',
  东北: 'northeast',
  东北话: 'northeast',
};

/**
 * Turn a word the model passed into an instruction string.
 *
 * @param {string} [emotion] Emotion word, English key or Chinese alias.
 * @returns {string} Instruction ending with the marker, or `''` for none.
 */
export function emotionInstruction(emotion) {
  const raw = String(emotion ?? '').trim().toLowerCase();
  if (raw === '') return '';
  const key = ALIASES[raw] ?? raw;
  const sentence = INSTRUCTIONS[key];
  if (sentence === undefined) return '';
  return `${PREFIX}${sentence}${MARK}`;
}

/**
 * The emotion keys this bridge knows about, for tool descriptions.
 *
 * @returns {string[]} Keys such as `angry` and `sad`.
 */
export function emotionNames() {
  return Object.keys(INSTRUCTIONS);
}
