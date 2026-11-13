import Dexie, { type Table } from 'dexie';

export class PanelDB extends Dexie {
  audits!: Table<any, number>;
  profiles!: Table<any, number>;
  logs!: Table<any, number>;
  voiceNotes!: Table<any, number>;
  expertReviews!: Table<any, number>;
  checklistOverrides!: Table<any, string>;
  checklistVersions!: Table<any, number>;
  settings!: Table<{ key: string; value: any }, string>;
  syncProfiles!: Table<any, string>;

  constructor() {
    super('panelapp');
    this.version(1).stores({ audits: '++id,createdAt,establishment', profiles: '++id,nombre' });
    this.version(2).stores({
      audits: '++id,createdAt,establishment', profiles: '++id,nombre',
      logs: '++id,createdAt,type,date,establishment,previousId',
      voiceNotes: '++id,createdAt,status,establishment',
    });
    this.version(3).stores({
      audits: '++id,createdAt,establishment', profiles: '++id,nombre',
      logs: '++id,createdAt,type,date,establishment,previousId',
      voiceNotes: '++id,createdAt,status,establishment',
      expertReviews: '++id,requirementId,createdAt,author',
      checklistOverrides: 'key', checklistVersions: '++id,createdAt,author,version',
    });
    this.version(4).stores({
      audits: '++id,createdAt,establishment,recordId', profiles: '++id,nombre',
      logs: '++id,createdAt,type,date,establishment,previousId,recordId,establishmentId,deviceId,chainIndex,syncStatus,[establishmentId+deviceId+chainIndex]',
      voiceNotes: '++id,createdAt,status,establishment',
      expertReviews: '++id,requirementId,createdAt,author',
      checklistOverrides: 'key', checklistVersions: '++id,createdAt,author,version',
      settings: 'key', syncProfiles: 'id,name,updatedAt',
    });
  }
}

export const db = new PanelDB();
