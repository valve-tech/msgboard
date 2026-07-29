export type StageArchetype = 'felt' | 'canvas' | 'strip' | 'wheel' | 'grid'

const FELT = new Set(['blackjack', 'baccarat', 'dragon-tiger', 'andar-bahar', 'three-card', 'pai-gow', 'craps', 'monte', 'hilo'])
const STRIP = new Set(['dice', 'dicex2', 'limbo'])
const CANVAS = new Set(['crash'])
const WHEEL = new Set(['roulette', 'wheel'])

/** Which stage surface a game renders into. Unknown ids fall back to the flat grid (safest, no perspective). */
export const archetypeFor = (gameId: string): StageArchetype =>
  FELT.has(gameId) ? 'felt' : STRIP.has(gameId) ? 'strip' : CANVAS.has(gameId) ? 'canvas' : WHEEL.has(gameId) ? 'wheel' : 'grid'
