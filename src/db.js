import { get, set, del } from "idb-keyval";

/**
 * IndexedDB 構成（v2）
 * - メタ配列:   META_KEY = 'fnp.meta.v2'  … [{id,name,createdAt,size,settings|null}, ...]
 * - 楽曲本体:  'fnp.blob.<id>'            … Uint8Array (MIDIバイト列)
 * 旧データ（配列に blob を内包）からは起動時に移行します。
 */

const META_KEY = "fnp.meta.v2";
const MAX_ITEMS = 50;
const blobKey = (id) => `fnp.blob.${id}`;
const uuid = () => crypto.randomUUID?.() || Math.random().toString(36).slice(2);

/** 旧フォーマットからの移行（必要な場合のみ実行） */
async function migrateIfNeeded() {
  const items = (await get(META_KEY)) ?? [];
  if (Array.isArray(items) && items.length > 0 && !("blob" in (items[0] || {}))) {
    // すでに v2 形式
    return items;
  }

  // v1 形式（配列要素に blob を内包）の推定
  const legacy = Array.isArray(items) ? items : (await get("fnp.library")) ?? [];
  if (!Array.isArray(legacy) || legacy.length === 0) return [];

  const migrated = [];
  for (const it of legacy) {
    const id = it.id || uuid();
    if (it.blob) {
      try {
        await set(blobKey(id), it.blob);
      } catch {
        // 失敗しても移行は続行
      }
    }
    migrated.push({
      id,
      name: it.name || "(無題)",
      createdAt: it.createdAt || Date.now(),
      size: it.size ?? (it.blob ? it.blob.length : 0),
      settings: it.settings ?? null,
    });
  }

  await set(META_KEY, migrated.slice(0, MAX_ITEMS));
  return migrated;
}

/** 一覧取得（作成日時降順） */
export async function listSongs() {
  const meta = (await get(META_KEY)) ?? [];
  const fixed = Array.isArray(meta) ? meta : [];
  const maybeMigrated = await migrateIfNeeded();
  const items = maybeMigrated.length ? maybeMigrated : fixed;
  return items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** 保存：MIDIバイト列と現在の設定をセットで保存 */
export async function saveSong(name, bytesU8, settings) {
  const id = uuid();
  const meta = {
    id,
    name: name || "(無題)",
    createdAt: Date.now(),
    size: bytesU8?.length ?? 0,
    settings: settings ?? null,
  };
  if (bytesU8) await set(blobKey(id), bytesU8);
  const items = await listSongs();
  await set(META_KEY, [meta, ...items].slice(0, MAX_ITEMS));
  return meta;
}

/** 読込：本体（Uint8Array）だけ取得 */
export async function loadSongBytes(id) {
  return (await get(blobKey(id))) || null;
}

/** 削除：メタ＋本体 */
export async function removeSong(id) {
  const items = await listSongs();
  await set(META_KEY, items.filter((x) => x.id !== id));
  await del(blobKey(id));
}
