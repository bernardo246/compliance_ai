export type TipoDocumento = 'pdf' | 'csv' | 'xlsx';

export type StatusDocumento = 'uploaded' | 'processing' | 'done' | 'error';

export const MIME_TO_TIPO: Record<string, TipoDocumento> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
