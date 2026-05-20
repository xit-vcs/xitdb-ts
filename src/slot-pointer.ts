import { Slot } from './slot.js';

export class SlotPointer {
  readonly position: number | null;
  readonly slot: Slot;

  constructor(position: number | null, slot: Slot) {
    this.position = position;
    this.slot = slot;
  }

  withSlot(slot: Slot): SlotPointer {
    return new SlotPointer(this.position, slot);
  }
}
