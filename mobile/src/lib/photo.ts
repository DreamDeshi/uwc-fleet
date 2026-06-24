import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";

// Compress every POD photo to ≤500KB before upload — drivers are often on weak
// rural mobile data, and the API/Cloudinary don't need a 5MB original.
const MAX_BYTES = 500 * 1024;
const TARGET_WIDTH = 1280;

export interface PickedPhoto {
  uri: string;
  name: string;
  type: string;
}

export type PhotoSource = "camera" | "library";

/**
 * Capture a photo for proof-of-delivery. Camera first (the normal flow for a
 * driver at the dropoff); if the camera permission is denied we fall back to
 * the photo library so the driver is never fully blocked. Returns null if the
 * driver cancels or grants neither permission.
 */
export async function capturePodPhoto(): Promise<PickedPhoto | null> {
  const cam = await ImagePicker.requestCameraPermissionsAsync();

  let result: ImagePicker.ImagePickerResult;
  if (cam.granted) {
    result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      allowsEditing: false,
    });
  } else {
    const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!lib.granted) return null;
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      allowsEditing: false,
    });
  }

  if (result.canceled || !result.assets?.length) return null;

  const compressedUri = await compressToLimit(result.assets[0].uri);
  return { uri: compressedUri, name: "pod.jpg", type: "image/jpeg" };
}

/** Pick a document (image) for a booking — DO / invoice from the gallery. */
export async function pickDocumentImage(): Promise<PickedPhoto | null> {
  const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!lib.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.85,
    allowsEditing: false,
  });
  if (result.canceled || !result.assets?.length) return null;

  const compressedUri = await compressToLimit(result.assets[0].uri);
  return { uri: compressedUri, name: "document.jpg", type: "image/jpeg" };
}

// Resize then step down JPEG quality until the file is under the limit. Most
// phone photos land under 500KB after the first pass; the loop is a safety net
// for very large originals.
async function compressToLimit(uri: string): Promise<string> {
  let quality = 0.7;
  let out = await manipulateAsync(uri, [{ resize: { width: TARGET_WIDTH } }], {
    compress: quality,
    format: SaveFormat.JPEG,
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    const size = fileSize(out.uri);
    if (size === null || size <= MAX_BYTES) break;
    quality = Math.max(quality - 0.15, 0.2);
    out = await manipulateAsync(uri, [{ resize: { width: TARGET_WIDTH } }], {
      compress: quality,
      format: SaveFormat.JPEG,
    });
  }

  return out.uri;
}

function fileSize(uri: string): number | null {
  try {
    return new File(uri).size ?? null;
  } catch {
    return null;
  }
}
