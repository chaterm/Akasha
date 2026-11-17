const { replace } = '';

const es = /&(?:amp|#38|lt|#60|gt|#62|apos|#39|quot|#34);/g;
const ca = /[&<>'"]/g;

const esca = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
};
const pe = (m) => esca[m];

export const htmlEscape = (es) => replace.call(es, ca, pe);

const unes = {
  '&amp;': '&',
  '&#38;': '&',
  '&lt;': '<',
  '&#60;': '<',
  '&gt;': '>',
  '&#62;': '>',
  '&apos;': "'",
  '&#39;': "'",
  '&quot;': '"',
  '&#34;': '"',
};
const cape = (m) => unes[m];

export const htmlUnescape = (un) => replace.call(un, es, cape);
