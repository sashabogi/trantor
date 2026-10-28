import SwiftUI
import TrantorDesign

struct AuroraSection<Content: View, Accessory: View>: View {
    let title: String
    let accessory: Accessory
    let content: Content
    init(_ title: String, @ViewBuilder accessory: () -> Accessory = { EmptyView() }, @ViewBuilder content: () -> Content) {
        self.title = title
        self.accessory = accessory()
        self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack { Eyebrow(title); Spacer(); accessory }
            content
        }
        .padding(Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .auroraPanel()
    }
}

struct AuroraPicker<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    init(_ options: [(Value, String)], selection: Binding<Value>) {
        self.options = options
        self._selection = selection
    }
    var body: some View {
        HStack(spacing: 4) {
            ForEach(options, id: \.0) { value, label in
                Button(label) { selection = value }
                    .buttonStyle(AuroraButtonStyle())
                    .background(selection == value ? Glass.selected.fill : Glass.transparent, in: Capsule())
                    .accessibilityAddTraits(selection == value ? .isSelected : [])
            }
        }
    }
}
