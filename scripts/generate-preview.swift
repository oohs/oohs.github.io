import AppKit

guard CommandLine.arguments.count == 2 else {
  fputs("usage: generate-preview.swift <output.png>\n", stderr)
  exit(2)
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let canvasSize = NSSize(width: 1200, height: 630)

guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(canvasSize.width),
  pixelsHigh: Int(canvasSize.height),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fputs("unable to create preview canvas\n", stderr)
  exit(3)
}

guard let font = NSFont(name: "Times New Roman", size: 108) else {
  fputs("Times New Roman is required to generate the preview\n", stderr)
  exit(4)
}

bitmap.size = canvasSize
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context

NSColor.white.setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: canvasSize)).fill()

let text = NSAttributedString(
  string: "lawrence's website",
  attributes: [
    .font: font,
    .foregroundColor: NSColor.black,
    .kern: 0,
  ]
)
let textSize = text.size()
text.draw(at: NSPoint(
  x: floor((canvasSize.width - textSize.width) / 2),
  y: floor((canvasSize.height - textSize.height) / 2)
))

NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
  fputs("unable to encode preview PNG\n", stderr)
  exit(5)
}

try png.write(to: outputURL, options: .atomic)
