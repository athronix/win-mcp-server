import type { Capability, CapabilitySpec, Domain } from '../contracts/capability.js';
import { cap } from './cap.js';

/** 能力注册表（FR-101）：ID 唯一、按域查询 */
export class CapabilityRegistry {
  readonly #items = new Map<string, Capability>();

  register(spec: CapabilitySpec): Capability {
    const normalized = cap(spec);
    if (this.#items.has(normalized.id)) {
      throw new Error(`DUPLICATE_CAPABILITY: ${normalized.id} 已注册`);
    }
    this.#items.set(normalized.id, normalized);
    return normalized;
  }

  registerAll(specs: readonly CapabilitySpec[]): Capability[] {
    const registered: Capability[] = [];
    for (const spec of specs) registered.push(this.register(spec));
    return registered;
  }

  get(id: string): Capability | undefined {
    return this.#items.get(id);
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }

  list(): readonly Capability[] {
    return Array.from(this.#items.values());
  }

  byDomain(domain: Domain): readonly Capability[] {
    return this.list().filter((item) => item.domain === domain);
  }

  get size(): number {
    return this.#items.size;
  }
}