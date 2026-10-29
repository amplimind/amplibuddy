// The animals a character can be. The species text ("small fox", "grumpy old bear") is free
// for the prompts; the look picks one of the drawn sprites.

export const LOOKS = ['fox', 'cat', 'dog', 'rabbit', 'bear', 'raccoon', 'hedgehog', 'mouse'] as const;
export type Look = (typeof LOOKS)[number];

export const LOOK_INFO: Record<Look, { label: string; species: string; keywords: RegExp }> = {
  fox: { label: 'Fox', species: 'small fox', keywords: /\bfox/i },
  cat: { label: 'Cat', species: 'cat', keywords: /\b(cat|kitten|kitty)/i },
  dog: { label: 'Dog', species: 'small dog', keywords: /\b(dog|pup|puppy)/i },
  rabbit: { label: 'Rabbit', species: 'rabbit', keywords: /\b(rabbit|bunny|hare)/i },
  bear: { label: 'Bear', species: 'bear cub', keywords: /\bbear/i },
  raccoon: { label: 'Raccoon', species: 'raccoon', keywords: /\braccoon/i },
  hedgehog: { label: 'Hedgehog', species: 'hedgehog', keywords: /\bhedgehog/i },
  mouse: { label: 'Mouse', species: 'mouse', keywords: /\b(mouse|mice)/i },
};

export function isLook(value: unknown): value is Look {
  return typeof value === 'string' && (LOOKS as readonly string[]).includes(value);
}

/** The sprite for a character: its `look` if valid, else guessed from the species text, else a fox. */
export function lookOf(species: string | undefined, look?: string): Look {
  if (isLook(look)) return look;
  return LOOKS.find((l) => LOOK_INFO[l].keywords.test(species ?? '')) ?? 'fox';
}
