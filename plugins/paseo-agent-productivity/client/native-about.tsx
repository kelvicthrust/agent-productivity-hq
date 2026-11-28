import { ExternalLink, Modal } from '@getpaseo/plugin/client/ui';
import { useState } from 'react';
import { View } from 'react-native';
import manifest from '../package.json' with { type: 'json' };
import {
  NativeAppearance,
  NativeButton,
  NativeRow,
  NativeText,
  useColors,
  useDashboardLayout,
} from './native-ui.tsx';

const title = 'About Agent Productivity HQ';
const repository = 'https://github.com/kelvicthrust/agent-productivity-hq';
const links = [
  { label: 'GitHub repository', href: repository },
  { label: 'Release notes', href: `${repository}/releases` },
  { label: 'Setup and troubleshooting', href: `${repository}/blob/main/docs/delivery/setup.md` },
];

export function NativeAbout() {
  const [open, setOpen] = useState(false);
  const theme = useColors();
  const layout = useDashboardLayout();
  return (
    <>
      <NativeButton label={title} icon="Info" iconOnly onPress={() => setOpen(true)} />
      {open && (
        <Modal title={title} open onOpenChange={setOpen}>
          <Modal.Content
            style={{ backgroundColor: theme.surface1 }}
            contentContainerStyle={{ gap: 12 }}
          >
            <NativeAppearance colors={theme} layout={layout}>
              <NativeText tone="foregroundMuted">
                A local dashboard for agent usage and merged GitHub pull requests.
              </NativeText>
              <NativeRow>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <NativeText tone="foregroundMuted">App version</NativeText>
                  <NativeText>{manifest.version}</NativeText>
                </View>
              </NativeRow>
              {links.map(({ href, label }) => (
                <NativeRow key={href}>
                  <ExternalLink href={href}>
                    <View style={{ minHeight: 44, justifyContent: 'center' }}>
                      <NativeText>{label}</NativeText>
                    </View>
                  </ExternalLink>
                </NativeRow>
              ))}
              <NativeRow>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <NativeText tone="foregroundMuted">Made with ❤️ by</NativeText>
                  <ExternalLink href="https://github.com/kelvicthrust">
                    <View style={{ minHeight: 44, justifyContent: 'center' }}>
                      <NativeText>kelvicthrust</NativeText>
                    </View>
                  </ExternalLink>
                </View>
              </NativeRow>
            </NativeAppearance>
          </Modal.Content>
        </Modal>
      )}
    </>
  );
}
