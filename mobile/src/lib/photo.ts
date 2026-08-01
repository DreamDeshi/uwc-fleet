import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { compressToLimit } from "./imageCompress";
import {
  openFileDialog,
  FILE_DIALOG_SUPPORTED,
  DOCUMENT_ACCEPT,
  type PickedFile,
} from "./filePicker";
import { isCompressibleType, asJpgName } from "./uploadTypes";

// Compress EVERY uploaded image to ≤500KB — drivers are often on weak rural
// mobile data, and the API/Cloudinary don't need a 5MB original. Applies to all
// four pickers below (POD, K2, requestor paperwork, feedback) on BOTH platforms;
// the per-platform implementation lives in imageCompress.ts / .web.ts and fails
// open, so it can never block a capture.

export interface PickedPhoto {
  uri: string;
  name: string;
  type: string;
}

export type PhotoSource = "camera" | "library";

/**
 * Distinguishes the two "no photo" outcomes: a user CANCEL is a non-event,
 * but PERMISSION DENIED must be told to the driver — without a POD photo the
 * Delivered gate never unlocks and the trip can never complete.
 *
 * Platform reality (audit 2026-07-05 #8): "permission_denied" is only
 * reachable on NATIVE — expo-image-picker's web implementation always grants
 * (browser capture is an <input type=file>, no permission prompt at all), so
 * the guidance copy points at the phone's Settings, not the browser.
 */
export type PodCaptureResult = PickedPhoto | "permission_denied" | null;

/**
 * Capture a photo for proof-of-delivery. Camera first (the normal flow for a
 * driver at the dropoff); if the camera permission is denied we fall back to
 * the photo library so the driver is never fully blocked. Returns null on a
 * user cancel, "permission_denied" when BOTH permissions are refused.
 */
export async function capturePodPhoto(): Promise<PodCaptureResult> {
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
    if (!lib.granted) return "permission_denied";
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      allowsEditing: false,
    });
  }

  if (result.canceled || !result.assets?.length) return null;

  return finalizePhoto(result.assets[0], "pod.jpg");
}

/**
 * Make a photo's uri survive a page reload before it goes into the POD
 * offline outbox. On web the picker hands back a blob: URL, which dies with
 * the document — convert it to a data: URI (works in fetch(), so the upload
 * path is unchanged). Native file:// URIs already persist in the app cache.
 */
export async function toDurablePhotoUri(photo: PickedPhoto): Promise<PickedPhoto> {
  if (Platform.OS !== "web" || !photo.uri.startsWith("blob:")) return photo;
  const blob = await (await fetch(photo.uri)).blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { ...photo, uri: dataUrl };
}

/**
 * A pick that may fail in a way worth telling the user about. "too_large" is its
 * own outcome rather than an error because a 12MB scan is an ordinary thing for
 * office staff to try, and the fix ("send a smaller file") belongs in the UI.
 */
export type PickedFileResult = PickedPhoto | "too_large" | null;

/**
 * Paperwork: a PDF **or** an image where the platform can offer both, an image
 * where it cannot.
 *
 * On web this opens a real file dialog — office staff at a desk are the people
 * who actually hold a scanned DO or a PDF invoice. On native it falls through to
 * the gallery, unchanged, because picking a PDF there needs a native module the
 * app does not carry (see filePicker.ts).
 *
 * ⚠ The FILE_DIALOG_SUPPORTED check is not decoration: without it a user who
 * cancels the web dialog would immediately get an image picker instead.
 */
export async function pickDocumentFile(): Promise<PickedFileResult> {
  const picked = await openFileDialog(DOCUMENT_ACCEPT);
  if (picked === "too_large") return "too_large";
  if (picked) return finalizeFile(picked);
  if (FILE_DIALOG_SUPPORTED) return null; // a genuine cancel
  return pickDocumentImage();
}

/** Feedback attachment — same split, widest accept. Low stakes by design. */
export async function pickFeedbackAttachment(): Promise<PickedFileResult> {
  const picked = await openFileDialog(DOCUMENT_ACCEPT);
  if (picked === "too_large") return "too_large";
  if (picked) return finalizeFile(picked);
  if (FILE_DIALOG_SUPPORTED) return null;
  return pickFeedbackImage();
}

/**
 * Compress a picked file — IMAGES ONLY.
 *
 * ⚠ A PDF must reach the server byte-for-byte. Re-encoding one is precisely how
 * pages get dropped, and paperwork is the class of document that runs to several
 * of them. The image branch reuses the same fail-open compressor as the camera
 * paths, so a PDF is not a special case that skips a safety net — it is a file
 * type that has no business being re-encoded at all.
 */
async function finalizeFile(picked: PickedFile): Promise<PickedPhoto> {
  if (!isCompressibleType(picked.type)) return picked;

  const uri = await compressToLimit(picked.uri);
  if (uri === picked.uri) return picked; // compression failed open

  return { uri, name: asJpgName(picked.name), type: "image/jpeg" };
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

  return finalizePhoto(result.assets[0], "document.jpg");
}

/**
 * Pick a screenshot to attach to "Report a problem or idea". Library only —
 * the point is a screenshot the user already took of the bug, not a fresh
 * camera shot. Returns null on cancel or a refused permission; feedback must
 * still send without it, so callers treat "no image" as normal.
 */
export async function pickFeedbackImage(): Promise<PickedPhoto | null> {
  const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!lib.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.8,
    allowsEditing: false,
  });
  if (result.canceled || !result.assets?.length) return null;

  return finalizePhoto(result.assets[0], "feedback.jpg");
}

/**
 * Turn a picked asset into the { uri, name, type } the upload hook expects,
 * compressing first on EVERY platform.
 *
 * ⚠ Web used to skip compression outright and upload the camera original. That
 * skip is gone, but the reason for it is not: the browser build must never touch
 * expo-image-manipulator or expo-file-system. imageCompress.web.ts uses Canvas
 * only, and both twins fail open, so the worst case here is the old behaviour —
 * an uncompressed upload — never a blocked capture.
 *
 * Whether compression actually happened is read off the uri rather than assumed:
 * a fail-open returns the ORIGINAL uri, and mislabelling a PNG as image/jpeg
 * because we assumed the re-encode ran would corrupt the stored asset's type.
 */
async function finalizePhoto(
  asset: ImagePicker.ImagePickerAsset,
  fallbackName: string
): Promise<PickedPhoto> {
  const uri = await compressToLimit(asset.uri);
  const compressed = uri !== asset.uri;

  if (compressed) return { uri, name: fallbackName, type: "image/jpeg" };

  return {
    uri: asset.uri,
    name: asset.fileName ?? fallbackName,
    type: asset.mimeType ?? "image/jpeg",
  };
}
