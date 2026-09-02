import SwiftUI
import UIKit
import CompanionCore

/// An operator identity image fetched from the paired workbench with the
/// device bearer token. The operator mark is the deterministic fallback for
/// missing, stale, or undecodable attachments, so identity never becomes an
/// empty placeholder.
struct BotAvatarView: View {
    let bot: Bot
    let size: CGFloat
    var state: OperatorSignalState = .idle
    /// Opt-in, mirroring OperatorSigil: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    @EnvironmentObject private var session: Session
    @State private var image: UIImage?
    @State private var failed = false

    private var crop: AvatarCrop { bot.avatarCrop ?? .operatorMark }
    private var usesImage: Bool { crop != .operatorMark && bot.avatarUrl != nil && !failed }

    var body: some View {
        Group {
            if usesImage, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(mask)
            } else {
                OperatorSigil(color: bot.color, size: size, state: state, animated: animated, comets: comets)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(bot.name) mark")
        .task(id: "\(bot.avatarUrl ?? "")|\(crop.rawValue)") {
            image = nil
            failed = false
            guard crop != .operatorMark, bot.avatarUrl != nil else { return }
            let data = await session.avatarData(for: bot)
            guard !Task.isCancelled else { return }
            guard let data, let decoded = UIImage(data: data) else {
                failed = true
                return
            }
            guard !Task.isCancelled else { return }
            image = decoded
        }
    }

    private var mask: AnyShape {
        switch crop {
        case .circle: AnyShape(Circle())
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        case .square, .operatorMark: AnyShape(Rectangle())
        }
    }
}

struct ChatAvatarView: View {
    let chat: Chat
    let size: CGFloat
    var state: OperatorSignalState = .idle
    /// Opt-in, mirroring OperatorSigil: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    var body: some View {
        switch chat {
        case let .bot(bot):
            BotAvatarView(bot: bot, size: size, state: state, animated: animated, comets: comets)
        case .room:
            OperatorSigil(color: "blue", size: size, state: state, animated: animated, comets: comets)
        }
    }
}
