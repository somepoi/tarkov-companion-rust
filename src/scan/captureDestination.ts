/** One explicitly armed, mounted destination for incoming screenshot captures. */
let destination: ((image: Blob) => void) | undefined

export function registerCaptureDestination(receive: (image: Blob) => void): () => void {
  destination = receive
  return () => {
    if (destination === receive) destination = undefined
  }
}

/** False keeps the incumbent Item Collection capture workflow. */
export function routeCapturedImage(image: Blob): boolean {
  if (!destination) return false
  destination(image)
  return true
}
