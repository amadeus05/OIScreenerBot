import { TradeAction, EntryType, ConfidenceLevel, ModuleName } from '../../domain/signal-analyzer/types';
import { 
  IsEnum, IsNumber, IsArray, IsString, IsDate, IsObject, IsPositive, 
  ArrayMinSize, IsOptional, Min, Max 
} from 'class-validator';
import { Type } from 'class-transformer';

export class AnalizationResultDto {
  @IsDate()
  @Type(() => Date)
  ts!: Date;

  @IsString()
  symbol!: string;

  @IsEnum(['LONG', 'SHORT', 'NO_TRADE'])
  action!: TradeAction;

  @IsEnum(['market', 'limit'])
  entryType!: EntryType;

  @IsNumber()
  @IsPositive()
  entryPrice!: number;

  @IsNumber()
  @IsPositive()
  sl!: number;

  @IsArray()
  @IsNumber({}, { each: true })
  @ArrayMinSize(1)
  tp!: number[];

  @IsArray()
  @IsNumber({}, { each: true })
  @ArrayMinSize(1)
  tpPct!: number[];

  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(1440) // 24 hours
  horizonMin!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  confidence!: number;

  @IsEnum(['LOW', 'MEDIUM', 'HIGH'])
  confidenceLevel!: ConfidenceLevel;

  @IsObject()
  modules!: Record<ModuleName, number>;

  @IsArray()
  @IsString({ each: true })
  reasonTags!: string[];

  @IsNumber()
  @Min(0.01)
  @Max(10)
  riskPct!: number;

  @IsObject()
  @IsOptional()
  meta?: {
    rawScore: number;
    moduleAgreement: number;
    [key: string]: any;
  };
}

export class CreateAnalizationResultDto extends AnalizationResultDto {}

export class UpdateAnalizationResultDto extends AnalizationResultDto {
  @IsString()
  @IsOptional()
  id?: string;
}
