import type {
  Command,
  Extractor,
  ModelProvider,
  Ranker,
  Resolver,
  SourceAdapter,
  Tool,
} from "../contracts/index.ts";
import { ExtensionError } from "./errors.ts";

/** A name-keyed registry that remembers which extension registered each entry. */
export class NamedRegistry<T extends { name: string }> {
  private readonly items = new Map<string, { item: T; extension: string }>();

  constructor(private readonly kind: string) {}

  register(item: T, extension = "host"): void {
    if (typeof item?.name !== "string" || item.name.length === 0) {
      throw new ExtensionError(`${this.kind} registered by "${extension}" has no name`, extension);
    }
    const existing = this.items.get(item.name);
    if (existing) {
      throw new ExtensionError(
        `duplicate ${this.kind} "${item.name}": already registered by "${existing.extension}", again by "${extension}"`,
        extension,
      );
    }
    this.items.set(item.name, { item, extension });
  }

  get(name: string): T | undefined {
    return this.items.get(name)?.item;
  }

  has(name: string): boolean {
    return this.items.has(name);
  }

  /** Which extension registered `name`. */
  owner(name: string): string | undefined {
    return this.items.get(name)?.extension;
  }

  /** Registration order. */
  list(): T[] {
    return [...this.items.values()].map((e) => e.item);
  }

  get size(): number {
    return this.items.size;
  }
}

/** Resolvers run lowest priority first; ties keep registration order. */
export class ResolverRegistry extends NamedRegistry<Resolver> {
  constructor() {
    super("resolver");
  }

  override list(): Resolver[] {
    // Array.prototype.sort is stable, so equal priorities stay in load order.
    return super.list().sort((a, b) => a.priority - b.priority);
  }
}

export class Registry {
  readonly sources = new NamedRegistry<SourceAdapter>("source");
  readonly extractors = new NamedRegistry<Extractor>("extractor");
  readonly resolvers = new ResolverRegistry();
  readonly rankers = new NamedRegistry<Ranker>("ranker");
  readonly providers = new NamedRegistry<ModelProvider>("provider");
  readonly commands = new NamedRegistry<Command>("command");
  readonly tools = new NamedRegistry<Tool>("tool");
}
