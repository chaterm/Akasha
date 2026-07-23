import { Module } from '@nestjs/common';
import { PageModule } from '../../../core/page/page.module';
import { ReviewService } from './review.service';
import { ReviewApplyService } from './review-apply.service';
import { ReviewController } from './review.controller';
import { ReviewSnapshotService } from './review-snapshot.service';

@Module({
  imports: [PageModule],
  controllers: [ReviewController],
  providers: [ReviewService, ReviewSnapshotService, ReviewApplyService],
  exports: [ReviewService, ReviewSnapshotService, ReviewApplyService],
})
export class ReviewModule {}
