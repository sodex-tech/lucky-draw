import { createPrize, createRound } from "./draw-engine.mjs";
import { SODEX_BOXES } from "./sodex-preset-assets.mjs";

export { SODEX_BOXES };

export const SODEX_DRAW_COUNTS = [100, 20, 2, 1];

// Apply only to the settings draft. Tickets and program title belong to the host.
export function applySodexPreset(config) {
  const prizes = SODEX_BOXES.map(({ name, description, icon }) =>
    createPrize({ name: `${name} Treasure Box`, description, icon }),
  );
  return {
    ...config,
    prizes,
    rounds: prizes.map((prize, index) => createRound({
      name: `Round ${index + 1} · ${SODEX_BOXES[index].name}`,
      items: [{ prizeId: prize.id, count: SODEX_DRAW_COUNTS[index] }],
    })),
  };
}
