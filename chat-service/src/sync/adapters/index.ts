import { ISyncAdapter } from './adapter.interface';
import { ScholarshipAdapter } from './scholarship.adapter';
import { JobsAdapter } from './jobs.adapter';
import { OffersAdapter } from './offers.adapter';
import { EventsAdapter } from './events.adapter';
import { UniversitiesAdapter } from './universities.adapter';
import { PackagesAdapter } from './packages.adapter';
import { TemplatesAdapter } from './templates.adapter';
import { SlidersAdapter } from './sliders.adapter';
import { NotesAdapter, BooksAdapter, LecturesAdapter, PapersAdapter } from './skeleton.adapters';
import { ResumesAdapter } from './resumes.adapter';

export * from './adapter.interface';

export const adapters: ISyncAdapter[] = [
  new ScholarshipAdapter(),
  new JobsAdapter(),
  new OffersAdapter(),
  new EventsAdapter(),
  new UniversitiesAdapter(),
  new PackagesAdapter(),
  new TemplatesAdapter(),
  new SlidersAdapter(),
  new NotesAdapter(),
  new BooksAdapter(),
  new LecturesAdapter(),
  new PapersAdapter(),
  new ResumesAdapter()
];

export default adapters;
