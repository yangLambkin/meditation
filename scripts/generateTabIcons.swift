// Rebuild the four tab icons at 3× density. Run: swift scripts/generateTabIcons.swift
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("miniprogram/images/icons")
let size = 81
for name in ["home", "timer", "team", "me"] {
  for active in [false, true] {
    let color: [CGFloat] = active ? [CGFloat(178)/255, CGFloat(151)/255, CGFloat(100)/255, 1] : [CGFloat(153)/255, CGFloat(161)/255, CGFloat(174)/255, 1]
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.scaleBy(x: CGFloat(size) / 27, y: CGFloat(size) / 27)
    context.translateBy(x: 0, y: 27)
    context.scaleBy(x: 1, y: -1)
    context.setStrokeColorSpace(CGColorSpaceCreateDeviceRGB())
    context.setStrokeColor(color)
    context.setLineWidth(1.8)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    func line(_ points: [(CGFloat, CGFloat)], close: Bool = false) {
      context.beginPath()
      context.move(to: CGPoint(x: points[0].0, y: points[0].1))
      for point in points.dropFirst() { context.addLine(to: CGPoint(x: point.0, y: point.1)) }
      if close { context.closePath() }
      context.strokePath()
    }
    func ellipse(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
      context.strokeEllipse(in: CGRect(x: x, y: y, width: w, height: h))
    }
    func arcBody(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat) {
      context.beginPath()
      context.move(to: CGPoint(x: x, y: y + 5))
      context.addCurve(to: CGPoint(x: x + w, y: y + 5), control1: CGPoint(x: x, y: y - 2), control2: CGPoint(x: x + w, y: y - 2))
      context.strokePath()
    }
    switch name {
    case "home":
      line([(3.5, 12), (13.5, 3.5), (23.5, 12)])
      line([(5.5, 10.5), (5.5, 23), (10.5, 23), (10.5, 16), (16.5, 16), (16.5, 23), (21.5, 23), (21.5, 10.5)])
    case "timer":
      ellipse(4, 6, 19, 19)
      line([(13.5, 10), (13.5, 15.5), (17, 18)])
      line([(10.5, 2.5), (16.5, 2.5)])
      line([(13.5, 2.5), (13.5, 6)])
      line([(21, 5), (23, 7)])
    case "team":
      ellipse(9.5, 4, 8, 8)
      ellipse(2, 7, 5.5, 5.5)
      ellipse(19.5, 7, 5.5, 5.5)
      arcBody(6.5, 17, 14)
      arcBody(1, 17, 5)
      arcBody(21, 17, 5)
    default:
      ellipse(8.5, 3.5, 10, 10)
      arcBody(4, 18, 19)
    }
    let image = context.makeImage()!
    let filename = "\(name)\(active ? "-active" : "").png"
    let destination = CGImageDestinationCreateWithURL(output.appendingPathComponent(filename) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination))
    print("Created \(filename) at \(size)×\(size)")
  }
}
