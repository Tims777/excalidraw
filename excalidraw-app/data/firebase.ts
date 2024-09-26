import { reconcileElements } from "../../packages/excalidraw";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "../../packages/excalidraw/element/types";
import { hashElementsVersion } from "../../packages/excalidraw/element";
import type Portal from "../collab/Portal";
import { restoreElements } from "../../packages/excalidraw/data/restore";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "../../packages/excalidraw/types";
import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";
import { decompressData } from "../../packages/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
  IV_LENGTH_BYTES,
} from "../../packages/excalidraw/data/encryption";
import { MIME_TYPES } from "../../packages/excalidraw/constants";
import type { SyncableExcalidrawElement } from ".";
import { getSyncableElements } from ".";
import type { Socket } from "socket.io-client";
import type { RemoteExcalidrawElement } from "../../packages/excalidraw/data/reconcile";

// private
// -----------------------------------------------------------------------------

const STORAGE_SERVER_URL = import.meta.env.VITE_APP_WS_SERVER_URL;

let FIREBASE_CONFIG: Record<string, any>;
try {
  FIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing firebase config. Supplied value: ${
      import.meta.env.VITE_APP_FIREBASE_CONFIG
    }`,
  );
  FIREBASE_CONFIG = {};
}

let firebasePromise: Promise<typeof import("firebase/app").default> | null =
  null;
let firebaseStoragePromise: Promise<any> | null | true = null;

let isFirebaseInitialized = false;

const _loadFirebase = async () => {
  const firebase = (
    await import(/* webpackChunkName: "firebase" */ "firebase/app")
  ).default;

  if (!isFirebaseInitialized) {
    try {
      firebase.initializeApp(FIREBASE_CONFIG);
    } catch (error: any) {
      // trying initialize again throws. Usually this is harmless, and happens
      // mainly in dev (HMR)
      if (error.code === "app/duplicate-app") {
        console.warn(error.name, error.code);
      } else {
        throw error;
      }
    }
    isFirebaseInitialized = true;
  }

  return firebase;
};

const _getFirebase = async (): Promise<
  typeof import("firebase/app").default
> => {
  if (!firebasePromise) {
    firebasePromise = _loadFirebase();
  }
  return firebasePromise;
};

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async () => {
  const firebase = await _getFirebase();
  if (!firebaseStoragePromise) {
    firebaseStoragePromise = import(
      /* webpackChunkName: "storage" */ "firebase/storage"
    );
  }
  if (firebaseStoragePromise !== true) {
    await firebaseStoragePromise;
    firebaseStoragePromise = true;
  }
  return firebase;
};

interface StoredScene {
  sceneVersion: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: StoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext;
  const iv = data.iv;

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, hashElementsVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = hashElementsVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const firebase = await loadFirebaseStorage();

  const erroredFiles = new Map<FileId, true>();
  const savedFiles = new Map<FileId, true>();

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        await firebase
          .storage()
          .ref(`${prefix}/${id}`)
          .put(
            new Blob([buffer], {
              type: MIME_TYPES.binary,
            }),
            {
              cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
            },
          );
        savedFiles.set(id, true);
      } catch (error: any) {
        erroredFiles.set(id, true);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = hashElementsVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext,
    iv,
  } as StoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  // Step 1: Retrieve most recent scene from server
  const prevStoredElements =
    (await loadFromFirebase(roomId, roomKey, socket)) ?? [];
  const prevHash = hashElementsVersion(elements);

  // Step 2: Merge local changes to calculate new scene
  const reconciledElements = getSyncableElements(
    reconcileElements(
      elements,
      prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
      appState,
    ),
  );

  const storedScene = await createSceneDocument(reconciledElements, roomKey);

  // Step 3: Try to replace scene on server
  // TODO: What if scene on server has been updated in the meantime? (response code 409)
  const body = new Uint8Array(
    storedScene.iv.byteLength + storedScene.ciphertext.byteLength,
  );
  body.set(new Uint8Array(storedScene.iv), 0);
  body.set(new Uint8Array(storedScene.ciphertext), storedScene.iv.byteLength);
  await fetch(`${STORAGE_SERVER_URL}/scene/${roomId}`, {
    method: "PUT",
    headers: {
      ETag: storedScene.sceneVersion.toString(),
      "If-Match": prevHash.toString(),
      "Content-Type": "application/octet-stream",
    },
    body,
  });

  // Step 4: Update version cache
  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return storedElements;
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<SyncableExcalidrawElement[] | null> => {
  const resp = await fetch(`${STORAGE_SERVER_URL}/scene/${roomId}`, {
    method: "GET",
  });

  if (resp.status === 404) {
    return null;
  }

  const data = await resp.arrayBuffer();
  const storedScene: StoredScene = {
    iv: data.slice(0, IV_LENGTH_BYTES),
    ciphertext: data.slice(IV_LENGTH_BYTES),
    sceneVersion: parseInt(resp.headers.get("ETag")!),
  };

  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const url = `https://firebasestorage.googleapis.com/v0/b/${
          FIREBASE_CONFIG.storageBucket
        }/o/${encodeURIComponent(prefix.replace(/^\//, ""))}%2F${id}`;
        const response = await fetch(`${url}?alt=media`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
