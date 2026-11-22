export const chatColorRoles = ['self', 'own-agent', 'human', 'other-agent'] as const;
export type ChatColorRole = typeof chatColorRoles[number];
export type ChatColors = Record<ChatColorRole, string>;
export const defaultChatColors: Readonly<ChatColors> = {
  self: '#0A0A0A', 'own-agent': '#1B1B1B', human: '#303030', 'other-agent': '#282D34',
};
export const chatColorFamilies = [
  ['Neutral', ['#0A0A0A', '#1B1B1B', '#303030', '#666666', '#B8B8B8', '#F0F0F0']],
  ['Slate', ['#141A22', '#282D34', '#3D4A5C', '#6B7F97', '#ACBED3', '#E3EBF4']],
  ['Blue', ['#111E33', '#203A5C', '#315B8C', '#5286BD', '#9CC1E5', '#DEECFA']],
  ['Teal', ['#102724', '#21433F', '#34645E', '#57958B', '#A0CFC4', '#DEF1EA']],
  ['Green', ['#18251B', '#2D4431', '#48694B', '#749E70', '#B6D3A7', '#E8F3DE']],
  ['Olive', ['#262919', '#424830', '#646C44', '#979D69', '#CED1A5', '#F0F0DB']],
  ['Amber', ['#2C2315', '#4C3C24', '#79613A', '#AF8E56', '#DDC498', '#F6EAD5']],
  ['Clay', ['#2E1D18', '#51352B', '#7C5140', '#B17C63', '#DDB49E', '#F5E4DA']],
  ['Rose', ['#2E1920', '#4E2C38', '#774657', '#AC7288', '#DCAABB', '#F6E0E8']],
  ['Violet', ['#221C33', '#3A2F50', '#594779', '#8971AF', '#BDA6DD', '#ECE2F8']],
] as const;
export const chatColorPresets = Array.from({ length: 6 }, (_, shade) =>
  chatColorFamilies.map(([family, colors]) => ({ name: `${family} ${shade + 1}`, value: colors[shade]! })),
).flat();

export function normalizeChatColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value.trim()) ? value.trim().toUpperCase() : null;
}
export function parseChatColors(value: unknown): ChatColors {
  const result = { ...defaultChatColors };
  if (value && typeof value === 'object') for (const role of chatColorRoles) {
    result[role] = normalizeChatColor((value as Record<string, unknown>)[role]) ?? result[role];
  }
  return result;
}
export function chatColorName(value: string): string {
  const named: Record<string, string> = { '#0A0A0A': 'Black', '#1B1B1B': 'Charcoal', '#303030': 'Grey', '#282D34': 'Cool grey' };
  return named[value] ?? chatColorPresets.find(color => color.value === value)?.name ?? 'Custom';
}
type RGB = number[];
const rgb = (hex: string): RGB => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const mix = (a: RGB, b: RGB, amount: number): RGB => a.map((channel, index) => channel * (1 - amount) + b[index]! * amount);
const luminance = (color: RGB) => color.map(channel => channel / 255)
  .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
export function chatColorContrast(a: RGB, b: RGB): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

/** Check the entire gradient, its hover fill and inline-code surface together. */
export function readableChatSurface(value: string) {
  const base = rgb(normalizeChatColor(value) ?? defaultChatColors.self);
  const white = [255, 255, 255], black = [0, 0, 0];
  for (const strength of [1, .75, .5, .25, 0]) {
    const start = mix(base, white, .06 * strength), end = mix(base, black, .14 * strength);
    const hover = .045 * strength;
    const stops = [start, base, end];
    const surfaces = [...stops, ...stops.map(stop => mix(stop, white, hover))];
    const score = (color: string) => Math.min(...surfaces.map(surface => chatColorContrast(rgb(color), surface)));
    const soft = ['#F1F1F3', '#171719'].sort((a, b) => score(b) - score(a))[0]!;
    const foreground = score(soft) >= 7 ? soft : ['#FFFFFF', '#000000'].sort((a, b) => score(b) - score(a))[0]!;
    if (score(foreground) < 4.5) continue;
    const darkText = luminance(rgb(foreground)) < .5;
    return {
      start: `rgb(${start.join(' ')})`, end: `rgb(${end.join(' ')})`, foreground,
      hover: `rgb(255 255 255 / ${hover})`,
      code: darkText ? 'rgb(255 255 255 / .12)' : 'rgb(0 0 0 / .10)',
      inlineCodeBackground: darkText ? '#D3DCE9' : '#3B3E47',
      inlineCodeForeground: darkText ? '#1E2633' : '#F5F7FA',
    };
  }
  // A flat solid color always has >= 4.5:1 contrast against black or white.
  throw new Error('No readable chat surface');
}

export function chatBubbleStyle(value: string): Record<string, string> {
  const color = normalizeChatColor(value) ?? defaultChatColors.self;
  const surface = readableChatSurface(color);
  return { '--chat-bubble': color, '--chat-bubble-start': surface.start, '--chat-bubble-end': surface.end,
    '--chat-foreground': surface.foreground, '--chat-hover': surface.hover, '--chat-code': surface.code,
    '--chat-inline-code-background': surface.inlineCodeBackground, '--chat-inline-code-foreground': surface.inlineCodeForeground };
}
