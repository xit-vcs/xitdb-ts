import type { Slot } from './slot.js';

export interface Slotted {
  slot(): Slot;
}
