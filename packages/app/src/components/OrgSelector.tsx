import React from 'react';
import { Control } from 'react-hook-form';
import { Select, SelectProps } from 'react-hook-form-mantine';
import { Text } from '@mantine/core';

import api from '@/api';

type GrafanaOrg = {
  id: number;
  name: string;
};

type OrgSelectorProps = {
  control: Control<any>;
  name: string;
  label?: string;
  placeholder?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
} & Partial<SelectProps<any>>;

export const OrgSelector = ({
  control,
  name,
  label = 'Grafana Organization',
  placeholder = 'Select organization',
  size = 'xs',
  ...props
}: OrgSelectorProps) => {
  const { data: orgs, isLoading, error } = api.useGrafanaOrgs();

  const options = React.useMemo(() => {
    if (!orgs || !Array.isArray(orgs)) {
      return [];
    }

    return orgs.map((org: GrafanaOrg) => ({
      value: org.id.toString(),
      label: `${org.name} (${org.id})`,
    }));
  }, [orgs]);

  if (error) {
    return (
      <div>
        <Text size="xxs" opacity={0.5} mb={4}>
          {label}
        </Text>
        <Text size="xs" color="red">
          Failed to load organizations
        </Text>
      </div>
    );
  }

  return (
    <div>
      <Text size="xxs" opacity={0.5} mb={4}>
        {label}
      </Text>
      <Select
        comboboxProps={{ withinPortal: false }}
        size={size}
        placeholder={isLoading ? 'Loading...' : placeholder}
        data={options}
        name={name}
        control={control}
        {...props}
      />
    </div>
  );
};

export default OrgSelector;
