/**
 * Tiles Manager
 *
 * Manages text tile CRUD operations and persistence.
 * Text tiles are labels displayed on the hex grid.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import type { TextTile, ServerMessage } from "../../shared/types.js";
import { log, debug } from "../logger.js";

export class TilesManager {
  private tiles = new Map<string, TextTile>();
  private filePath: string;
  private broadcastFn: ((msg: ServerMessage) => void) | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  /** Load tiles from disk */
  load(): void {
    if (!existsSync(this.filePath)) {
      debug("No saved tiles file found");
      return;
    }

    try {
      const content = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(content) as TextTile[];

      for (const tile of data) {
        this.tiles.set(tile.id, tile);
      }

      log(`Loaded ${this.tiles.size} tiles from ${this.filePath}`);
    } catch (e) {
      console.error("Failed to load tiles:", e);
    }
  }

  /** Get all tiles */
  getAll(): TextTile[] {
    return Array.from(this.tiles.values());
  }

  /** Get a tile by ID */
  get(id: string): TextTile | undefined {
    return this.tiles.get(id);
  }

  /** Create a new tile */
  create(tile: TextTile): void {
    this.tiles.set(tile.id, tile);
    this.save();
    this.broadcastTiles();
    log(
      `Created text tile: "${tile.text}" at (${tile.position.q}, ${tile.position.r})`,
    );
  }

  /** Update a tile */
  update(
    id: string,
    updates: { text?: string; position?: { q: number; r: number }; color?: string },
  ): TextTile | null {
    const tile = this.tiles.get(id);
    if (!tile) return null;

    if (updates.text !== undefined) tile.text = updates.text;
    if (updates.position !== undefined) tile.position = updates.position;
    if (updates.color !== undefined) tile.color = updates.color;

    this.save();
    this.broadcastTiles();
    log(`Updated text tile: "${tile.text}"`);
    return tile;
  }

  /** Delete a tile */
  delete(id: string): boolean {
    const tile = this.tiles.get(id);
    if (!tile) return false;

    this.tiles.delete(id);
    this.save();
    this.broadcastTiles();
    log(`Deleted text tile: "${tile.text}"`);
    return true;
  }

  /** Save tiles to disk */
  private save(): void {
    try {
      const data = Array.from(this.tiles.values());
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
      debug(`Saved ${this.tiles.size} tiles to ${this.filePath}`);
    } catch (e) {
      console.error("Failed to save tiles:", e);
    }
  }

  /** Broadcast tiles to all clients */
  private broadcastTiles(): void {
    if (this.broadcastFn) {
      this.broadcastFn({
        type: "text_tiles",
        payload: this.getAll(),
      });
    }
  }
}
