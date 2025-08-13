import { useEffect, useMemo, useState } from 'react';
import { Control, useController } from 'react-hook-form';
import { Select, SelectProps } from 'react-hook-form-mantine';
import { Label, ReferenceArea, ReferenceLine } from 'recharts';
import type { AlertChannelType } from '@hyperdx/common-utils/dist/types';
import {
  ActionIcon,
  Button,
  ComboboxData,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconTrash } from '@tabler/icons-react';

import api from '@/api';

import { CreateWebhookForm } from '../TeamPage';

type Webhook = {
  _id: string;
  name: string;
};

const WebhookChannelForm = <T extends object>(
  props: Partial<SelectProps<T>>,
) => {
  const { data: webhooks, refetch: refetchWebhooks } = api.useWebhooks([
    'slack',
    'generic',
    'alertmanager',
  ]);
  const [opened, { open, close }] = useDisclosure(false);

  const hasWebhooks = Array.isArray(webhooks?.data) && webhooks.data.length > 0;

  const options = useMemo<ComboboxData>(() => {
    const webhookOptions =
      webhooks?.data.map((sw: Webhook) => ({
        value: sw._id,
        label: sw.name,
      })) || [];

    return [
      {
        value: '',
        label: 'Select a Webhook',
        disabled: true,
      },
      ...webhookOptions,
    ];
  }, [webhooks]);

  const { field } = useController({
    control: props.control,
    name: props.name!,
  });

  const handleWebhookCreated = async (webhookId?: string) => {
    await refetchWebhooks();
    if (webhookId) {
      field.onChange(webhookId);
      field.onBlur();
    }
    close();
  };

  return (
    <div>
      <Group gap="md" justify="space-between">
        <Select
          comboboxProps={{
            withinPortal: false,
          }}
          required
          size="xs"
          flex={1}
          placeholder={
            hasWebhooks ? 'Select a Webhook' : 'No Webhooks available'
          }
          data={options}
          name={props.name!}
          control={props.control}
          {...props}
        />
        <Button size="xs" variant="subtle" color="gray" onClick={open}>
          Add New Incoming Webhook
        </Button>
      </Group>

      <Modal
        opened={opened}
        onClose={close}
        title="Add New Webhook"
        centered
        zIndex={9999}
        size="lg"
      >
        <CreateWebhookForm onClose={close} onSuccess={handleWebhookCreated} />
      </Modal>
    </div>
  );
};

export const AlertChannelForm = ({
  control,
  type,
  namePrefix = '',
}: {
  control: Control<any>; // TODO: properly type this
  type: AlertChannelType;
  namePrefix?: string;
}) => {
  if (type === 'webhook') {
    return (
      <Stack gap="xs">
        <WebhookChannelForm
          control={control}
          name={`${namePrefix}channel.webhookId`}
        />
        <LabelsInput control={control} namePrefix={namePrefix} />
      </Stack>
    );
  }

  return null;
};

const LabelsInput = ({
  control,
  namePrefix = '',
}: {
  control: Control<any>;
  namePrefix?: string;
}) => {
  const { field } = useController({
    name: `${namePrefix}channel.labels`,
    control,
  });

  type Label = { key: string; value: string };

  const [labels, setLabels] = useState<Label[]>(() => {
    if (field.value) {
      return Object.entries(field.value).map(([key, value]) => ({
        key,
        value: String(value),
      }));
    }

    return [
      { key: 'alert_type', value: 'hyperdx' },
      { key: 'alertname', value: '$alertname' },
    ];
  });

  const addLabel = () => {
    setLabels(prev => [...prev, { key: '', value: '' }]);
  };

  const removeLabel = (index: number) => {
    setLabels((prev: Label[]) => prev.filter((_, i) => i !== index));
  };

  const updateLabel = (
    index: number,
    field: 'key' | 'value',
    value: string,
  ) => {
    setLabels(
      labels.map((label, i) =>
        i === index ? { ...label, [field]: value } : label,
      ),
    );
  };

  // 当 labels 变化时，更新表单值
  useEffect(() => {
    const labelsMap: Record<string, string> = {};
    labels
      .filter(label => label.key?.trim() && label.value?.trim())
      .forEach(label => {
        labelsMap[label.key] = label.value;
      });

    // 只有当新的值与当前值不同时才更新，避免无限循环
    const currentValue = field.value;
    const newValueStr = JSON.stringify(labelsMap);
    const currentValueStr = JSON.stringify(currentValue);

    if (newValueStr !== currentValueStr) {
      field.onChange(labelsMap);
    }
  }, [field, labels]);

  return (
    <div>
      <Text size="xs" mb={8} opacity={0.7}>
        Labels
      </Text>
      <Stack gap="xs">
        {labels.map((label, index) => (
          <Group key={index} gap="xs">
            <TextInput
              placeholder="Key"
              value={label.key}
              onChange={e => updateLabel(index, 'key', e.currentTarget.value)}
              size="xs"
              style={{ flex: 1 }}
            />
            <TextInput
              placeholder="Value"
              value={label.value}
              onChange={e => updateLabel(index, 'value', e.currentTarget.value)}
              size="xs"
              style={{ flex: 1 }}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => removeLabel(index)}
              size="xs"
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
        <Button
          variant="light"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={addLabel}
        >
          Add Label
        </Button>
      </Stack>
    </div>
  );
};

export const getAlertReferenceLines = ({
  thresholdType,
  threshold,
  // TODO: zScore
}: {
  thresholdType: 'above' | 'below';
  threshold: number;
}) => (
  <>
    {threshold != null && thresholdType === 'below' && (
      <ReferenceArea
        y1={0}
        y2={threshold}
        ifOverflow="extendDomain"
        fill="red"
        strokeWidth={0}
        fillOpacity={0.05}
      />
    )}
    {threshold != null && thresholdType === 'above' && (
      <ReferenceArea
        y1={threshold}
        ifOverflow="extendDomain"
        fill="red"
        strokeWidth={0}
        fillOpacity={0.05}
      />
    )}
    {threshold != null && (
      <ReferenceLine
        y={threshold}
        label={
          <Label
            value="Alert Threshold"
            fill={'white'}
            fontSize={11}
            opacity={0.7}
          />
        }
        stroke="red"
        strokeDasharray="3 3"
      />
    )}
  </>
);
