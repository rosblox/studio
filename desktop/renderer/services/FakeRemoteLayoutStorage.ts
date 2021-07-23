// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { v4 as uuidv4 } from "uuid";

import { MutexLocked } from "@foxglove/den/async";
import {
  IRemoteLayoutStorage,
  ISO8601Timestamp,
  LayoutID,
  PanelsState,
  RemoteLayout,
  RemoteLayoutMetadata,
  UserID,
} from "@foxglove/studio-base";

import { Storage } from "../../common/types";

function assertLayout(value: unknown): asserts value is RemoteLayout {
  if (typeof value !== "object" || value == undefined) {
    throw new Error("Invariant violation - layout item is not an object");
  }

  if (!("id" in value)) {
    throw new Error("Invariant violation - layout item is missing an id");
  }
}

const FAKE_USER_ID = "fakeuser" as UserID;

/**
 * An implementation of "remote" layout storage that stores layouts in native storage for debugging
 * purposes.
 *
 * We append the .json extension to cache keys so it's easier to browse the raw files on disk in a
 * GUI.
 *
 * @see NativeStorageLayoutStorage
 */
export default class FakeRemoteLayoutStorage implements IRemoteLayoutStorage {
  private static STORE_NAME = "fake-remote-layouts";

  storage: MutexLocked<Storage>;
  constructor(storage: Storage) {
    this.storage = new MutexLocked(storage);
  }

  private async hasNameConflictUnlocked(
    storage: Storage,
    {
      ignoringId,
      name,
      permission,
    }: {
      ignoringId: LayoutID | undefined;
      name: string;
      permission: "creator_write" | "org_read" | "org_write";
    },
  ): Promise<boolean> {
    const items = await storage.all(FakeRemoteLayoutStorage.STORE_NAME);

    for (const item of items) {
      if (!(item instanceof Uint8Array)) {
        throw new Error("Invariant violation - layout item is not a buffer");
      }

      const str = new TextDecoder().decode(item);
      const parsed: RemoteLayout = JSON.parse(str);
      assertLayout(parsed);

      if (
        (ignoringId == undefined || ignoringId !== parsed.id) &&
        (permission === "creator_write") === (parsed.permission === "creator_write") &&
        parsed.name === name
      ) {
        return true;
      }
    }
    return false;
  }

  async getLayouts(): Promise<readonly RemoteLayoutMetadata[]> {
    return await this.storage.runExclusive(
      async (storage) => await this.getLayoutsUnlocked(storage),
    );
  }
  private async getLayoutsUnlocked(storage: Storage): Promise<readonly RemoteLayoutMetadata[]> {
    const items = await storage.all(FakeRemoteLayoutStorage.STORE_NAME);
    const layouts: RemoteLayoutMetadata[] = [];
    for (const item of items) {
      if (!(item instanceof Uint8Array)) {
        throw new Error("Invariant violation - layout item is not a buffer");
      }

      const str = new TextDecoder().decode(item);
      const parsed: RemoteLayout = JSON.parse(str);
      assertLayout(parsed);
      const { data: _, ...metadata } = parsed;
      layouts.push(metadata);
    }

    return layouts;
  }

  async getLayout(id: LayoutID): Promise<RemoteLayout | undefined> {
    return await this.storage.runExclusive(
      async (storage) => await this.getLayoutUnlocked(storage, id),
    );
  }
  private async getLayoutUnlocked(
    storage: Storage,
    id: LayoutID,
  ): Promise<RemoteLayout | undefined> {
    const item = await storage.get(FakeRemoteLayoutStorage.STORE_NAME, id + ".json");
    if (item == undefined) {
      return undefined;
    }
    if (!(item instanceof Uint8Array)) {
      throw new Error("Invariant violation - layout item is not a buffer");
    }

    const str = new TextDecoder().decode(item);
    const parsed = JSON.parse(str);
    assertLayout(parsed);

    return parsed;
  }

  async saveNewLayout({
    name,
    data,
    permission,
  }: {
    name: string;
    data: PanelsState;
    permission: "creator_write" | "org_read" | "org_write";
  }): Promise<{ status: "success"; newMetadata: RemoteLayoutMetadata } | { status: "conflict" }> {
    return await this.storage.runExclusive(async (storage) => {
      if (
        await this.hasNameConflictUnlocked(storage, {
          ignoringId: undefined,
          name,
          permission,
        })
      ) {
        return { status: "conflict" };
      }
      const now = new Date().toISOString() as ISO8601Timestamp;
      const newMetadata: RemoteLayoutMetadata = {
        id: uuidv4() as LayoutID,
        name,
        creatorUserId: FAKE_USER_ID,
        createdAt: now,
        updatedAt: now,
        permission,
      };
      const newLayout: RemoteLayout = { ...newMetadata, data };
      await storage.put(
        FakeRemoteLayoutStorage.STORE_NAME,
        newLayout.id + ".json",
        JSON.stringify(newLayout, undefined, 2),
      );

      return { status: "success", newMetadata };
    });
  }

  async updateLayout({
    targetID,
    name,
    data,
    permission,
    ifUnmodifiedSince,
  }: {
    targetID: LayoutID;
    name?: string;
    data?: PanelsState;
    permission?: "creator_write" | "org_read" | "org_write";
    ifUnmodifiedSince: ISO8601Timestamp;
  }): Promise<
    | { status: "success"; newMetadata: RemoteLayoutMetadata }
    | { status: "not-found" }
    | { status: "conflict" }
    | { status: "precondition-failed" }
  > {
    return await this.storage.runExclusive(async (storage) => {
      const target = await this.getLayoutUnlocked(storage, targetID);
      if (!target) {
        return { status: "not-found" };
      }
      if (target.updatedAt !== ifUnmodifiedSince) {
        return { status: "precondition-failed" };
      }
      if (
        await this.hasNameConflictUnlocked(storage, {
          ignoringId: targetID,
          name: name ?? target.name,
          permission: permission ?? target.permission,
        })
      ) {
        return { status: "conflict" };
      }
      const newLayout: RemoteLayout = {
        ...target,
        name: name ?? target.name,
        data: data ?? target.data,
        permission: permission ?? target.permission,
        updatedAt: new Date().toISOString() as ISO8601Timestamp,
      };
      await storage.put(
        FakeRemoteLayoutStorage.STORE_NAME,
        targetID + ".json",
        JSON.stringify(newLayout, undefined, 2),
      );
      const { data: _, ...newMetadata } = newLayout;
      return { status: "success", newMetadata };
    });
  }

  async deleteLayout({
    targetID,
    ifUnmodifiedSince,
  }: {
    targetID: LayoutID;
    ifUnmodifiedSince: ISO8601Timestamp;
  }): Promise<{ status: "success" | "precondition-failed" }> {
    return await this.storage.runExclusive(async (storage) => {
      const target = await this.getLayoutUnlocked(storage, targetID);
      if (!target) {
        return { status: "success" };
      }
      if (target.updatedAt !== ifUnmodifiedSince) {
        return { status: "precondition-failed" };
      }
      await storage.delete(FakeRemoteLayoutStorage.STORE_NAME, targetID + ".json");
      return { status: "success" };
    });
  }
}
